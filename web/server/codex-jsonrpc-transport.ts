import { serverWorkAdmission } from "./server-work-admission.js";
import { coreActionLatency } from "./core-action-latency.js";
import { randomUUID } from "node:crypto";
import type { RecorderManager } from "./recorder.js";
import { getTrafficMessageType, trafficStats } from "./traffic-stats.js";

export interface JsonRpcRequest {
  method: string;
  id: number;
  params: Record<string, unknown>;
}

export interface JsonRpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface JsonRpcMessageSummary {
  direction: "in" | "out";
  ts: number;
  bytes: number;
  method: string | null;
  id: number | null;
  kind: "request" | "notification" | "response" | "invalid_json";
}

export interface JsonRpcPendingRequestSummary {
  id: number;
  method: string;
  ageMs: number;
}

export interface JsonRpcTransportCloseDiagnostics {
  closeId: string;
  sessionId: string;
  closedAt: number;
  closeContext: string;
  bufferedChars: number;
  pendingRequests: JsonRpcPendingRequestSummary[];
  recentIncoming: JsonRpcMessageSummary[];
  recentOutgoing: JsonRpcMessageSummary[];
  lastIncomingAt: number | null;
  lastOutgoingAt: number | null;
}

/** Captured at load so the drain loop still yields when a test fakes timers. */
const realSetImmediate = globalThis.setImmediate;
const yieldToEventLoop = () => new Promise<void>((resolve) => realSetImmediate(() => resolve()));

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class JsonRpcTransport {
  private nextId = 1;
  private pending = new Map<
    number,
    { method: string; createdAt: number; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private requestHandler: ((method: string, id: number, params: Record<string, unknown>) => void) | null = null;
  /** Codex requests this side has not answered, when tracking is on (see `trackUnansweredRequests`). */
  private unanswered: Map<number, JsonRpcRequest> | null = null;
  private unansweredChangeCb: ((requests: JsonRpcRequest[]) => void) | null = null;
  private rawInCbs: Array<(line: string, parsed: JsonRpcMessage | undefined) => void> = [];
  private rawOutCbs: Array<(data: string, message: JsonRpcMessage) => void> = [];
  private closeCb: (() => void) | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private connected = true;
  /**
   * The unfinished line, kept as the decoded pieces it arrived in and joined
   * once when its newline arrives. Appending each chunk to one string and
   * re-splitting it copied and rescanned a large response on every chunk,
   * which made a 32 MiB `thread/resume` response block the event loop for
   * seconds.
   */
  private partialLine: string[] = [];
  private partialLineChars = 0;
  private closeContext = "unknown";
  private sessionId: string;
  private recentIncoming: JsonRpcMessageSummary[] = [];
  private recentOutgoing: JsonRpcMessageSummary[] = [];
  private lastIncomingAt: number | null = null;
  private lastOutgoingAt: number | null = null;
  private lastCloseDiagnostics: JsonRpcTransportCloseDiagnostics | null = null;
  private recorder?: RecorderManager;
  private cwd: string;
  private static readonly RECENT_MESSAGE_SUMMARY_LIMIT = 12;
  /** Processing time after which a drain of already-buffered output lets other work run. */
  private static readonly DRAIN_SLICE_MS = 20;

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
    sessionId: string,
    recorder?: RecorderManager,
    cwd = "",
  ) {
    this.sessionId = sessionId;
    this.recorder = recorder;
    this.cwd = cwd;
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      const bunStdin = stdin as { write(data: Uint8Array): number };
      writable = new WritableStream({
        async write(chunk) {
          let offset = 0;
          while (offset < chunk.length) {
            const written = bunStdin.write(offset === 0 ? chunk : chunk.subarray(offset));
            if (written <= 0) {
              await new Promise<void>((r) => setTimeout(r, 1));
              continue;
            }
            offset += written;
          }
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    this.writer = writable.getWriter();

    this.onRawIncoming((line, parsed) => {
      recorder?.record(sessionId, "in", line, "cli", "codex", cwd);
      trafficStats.record({
        sessionId,
        channel: "cli",
        direction: "in",
        messageType: parsed ? getTrafficMessageType(parsed) : "invalid_json",
        payloadBytes: Buffer.byteLength(line, "utf-8"),
      });
    });
    this.onRawOutgoing((data, message) => {
      recorder?.record(sessionId, "out", data.trimEnd(), "cli", "codex", cwd);
      trafficStats.record({
        sessionId,
        channel: "cli",
        direction: "out",
        messageType: getTrafficMessageType(message),
        payloadBytes: Buffer.byteLength(data, "utf-8"),
      });
    });

    this.readStdout(stdout);
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    // Output Codex already wrote arrives without waiting, so a large response
    // can be drained in one go; let timers, HTTP and WebSocket work in between.
    let busyMs = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          this.closeContext = `stdout_eof(buffer=${this.partialLineChars})`;
          break;
        }
        const startedAt = performance.now();
        this.processChunk(decoder.decode(value, { stream: true }));
        busyMs += performance.now() - startedAt;
        if (busyMs >= JsonRpcTransport.DRAIN_SLICE_MS) {
          busyMs = 0;
          await yieldToEventLoop();
        }
      }
    } catch (err) {
      this.closeContext = `stdout_read_error:${err instanceof Error ? err.message : String(err)}`;
      console.error("[codex-adapter] stdout reader error:", err);
    } finally {
      this.connected = false;
      this.lastCloseDiagnostics = this.buildCloseDiagnostics();
      this.recorder?.recordServerEvent(
        this.sessionId,
        "codex_transport_closed",
        this.lastCloseDiagnostics as unknown as Record<string, unknown>,
        "codex",
        this.cwd,
      );
      for (const [, { reject }] of this.pending) {
        reject(new Error("Transport closed"));
      }
      this.pending.clear();
      this.closeCb?.();
    }
  }

  /** Handle each line the chunk completes, scanning only the new text for newlines. */
  private processChunk(text: string): void {
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      let line = text.slice(start, newline);
      if (this.partialLine.length > 0) {
        this.partialLine.push(line);
        line = this.partialLine.join("");
        this.partialLine = [];
        this.partialLineChars = 0;
      }
      this.processLine(line);
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (start < text.length) {
      const rest = start === 0 ? text : text.slice(start);
      this.partialLine.push(rest);
      this.partialLineChars += rest.length;
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Parse once; diagnostics and traffic accounting reuse the result.
    let msg: JsonRpcMessage | undefined;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) msg = parsed as JsonRpcMessage;
    } catch {}
    this.recordMessageSummary("in", trimmed, msg);
    for (const cb of this.rawInCbs) cb(trimmed, msg);
    if (!msg) {
      console.warn("[codex-adapter] Failed to parse JSON-RPC:", trimmed.substring(0, 200));
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: JsonRpcMessage): void {
    if ("id" in msg && msg.id !== undefined) {
      if ("method" in msg && msg.method) {
        if (this.unanswered) {
          // A taken-over process resends its open requests on `thread/resume`
          // (seen with app-server 0.153.4), which `redeliverRequests` may already
          // have handled: ask the user once.
          if (this.unanswered.has(msg.id as number)) return;
          this.unanswered.set(msg.id as number, msg as JsonRpcRequest);
          this.unansweredChangeCb?.([...this.unanswered.values()]);
        }
        try {
          this.requestHandler?.(msg.method, msg.id as number, (msg as JsonRpcRequest).params || {});
        } catch (err) {
          console.error(`[codex-adapter] Request handler failed for ${msg.method}:`, err);
        }
      } else {
        const pending = this.pending.get(msg.id as number);
        if (pending) {
          this.pending.delete(msg.id as number);
          coreActionLatency.record(`codex-rpc ${pending.method}`, Date.now() - pending.createdAt);
          const resp = msg as JsonRpcResponse;
          if (resp.error) {
            pending.reject(new Error(resp.error.message));
          } else {
            pending.resolve(resp.result);
          }
        }
      }
    } else if ("method" in msg) {
      try {
        this.notificationHandler?.(msg.method, (msg as JsonRpcNotification).params || {});
      } catch (err) {
        console.error(`[codex-adapter] Notification handler failed for ${msg.method}:`, err);
      }
    }
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    return this.request(method, params, timeoutMs).promise;
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    if (serverWorkAdmission.isStopping() && (method === "turn/start" || method === "turn/steer")) {
      return { id, promise: Promise.reject(new Error("Server is shutting down; turn dispatch deferred")) };
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settle =
        <T extends unknown[]>(fn: (...args: T) => void) =>
        (...args: T) => {
          if (timeout) clearTimeout(timeout);
          fn(...args);
        };
      this.pending.set(id, { method, createdAt: Date.now(), resolve: settle(resolve), reject: settle(reject) });
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.writeMessage({ method, id, params }).catch((err) => {
        if (timeout) clearTimeout(timeout);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    return { id, promise };
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.writeMessage({ method, params });
  }

  async respond(id: number, result: unknown): Promise<void> {
    if (this.unanswered?.delete(id)) this.unansweredChangeCb?.([...this.unanswered.values()]);
    await this.writeMessage({ id, result });
  }

  /**
   * Report every change to the set of Codex requests this side has not
   * answered yet, so a coordinator that restarts while the process keeps
   * running can answer them (see `redeliverRequests`).
   */
  trackUnansweredRequests(onChange: (requests: JsonRpcRequest[]) => void): void {
    this.unanswered = new Map();
    this.unansweredChangeCb = onChange;
  }

  /**
   * Handle requests an earlier client of this process received but never
   * answered, as if they just arrived. One the process also resends is handled once.
   */
  redeliverRequests(requests: JsonRpcRequest[]): void {
    for (const request of requests) this.dispatch(request);
  }

  /** Number this side's requests from `firstId`, clear of ids an earlier client of the process used. */
  startRequestIdsAt(firstId: number): void {
    this.nextId = firstId;
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: (method: string, id: number, params: Record<string, unknown>) => void): void {
    this.requestHandler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** `parsed` is the line's JSON-RPC message, or undefined when it is not a JSON object. */
  onRawIncoming(cb: (line: string, parsed: JsonRpcMessage | undefined) => void): void {
    this.rawInCbs.push(cb);
  }

  onRawOutgoing(cb: (data: string, message: JsonRpcMessage) => void): void {
    this.rawOutCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  getPendingIds(): number[] {
    return [...this.pending.keys()];
  }

  getPendingRequests(): JsonRpcPendingRequestSummary[] {
    return this.summarizePendingRequests(Date.now());
  }

  getCloseContext(): string {
    return this.closeContext;
  }

  getCloseDiagnostics(): JsonRpcTransportCloseDiagnostics | null {
    return this.lastCloseDiagnostics;
  }

  private async writeMessage(message: JsonRpcMessage): Promise<void> {
    if (!this.connected) {
      throw new Error("Transport closed");
    }
    const line = JSON.stringify(message);
    const data = line + "\n";
    this.recordMessageSummary("out", line, message);
    for (const cb of this.rawOutCbs) cb(data, message);
    try {
      await this.writer.write(new TextEncoder().encode(data));
    } catch (err) {
      console.error(
        `[codex-adapter] stdin write failed for session ${this.sessionId}:`,
        err instanceof Error ? err.message : String(err),
      );
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private buildCloseDiagnostics(): JsonRpcTransportCloseDiagnostics {
    const closedAt = Date.now();
    return {
      closeId: randomUUID(),
      sessionId: this.sessionId,
      closedAt,
      closeContext: this.closeContext,
      bufferedChars: this.partialLineChars,
      pendingRequests: this.summarizePendingRequests(closedAt),
      recentIncoming: [...this.recentIncoming],
      recentOutgoing: [...this.recentOutgoing],
      lastIncomingAt: this.lastIncomingAt,
      lastOutgoingAt: this.lastOutgoingAt,
    };
  }

  private summarizePendingRequests(now: number): JsonRpcPendingRequestSummary[] {
    return [...this.pending.entries()].map(([id, pending]) => ({
      id,
      method: pending.method,
      ageMs: Math.max(0, now - pending.createdAt),
    }));
  }

  private recordMessageSummary(direction: "in" | "out", raw: string, parsed: JsonRpcMessage | undefined): void {
    const summary = summarizeJsonRpcMessage(direction, raw, parsed);
    const target = direction === "in" ? this.recentIncoming : this.recentOutgoing;
    target.push(summary);
    if (target.length > JsonRpcTransport.RECENT_MESSAGE_SUMMARY_LIMIT) target.shift();
    if (direction === "in") this.lastIncomingAt = summary.ts;
    else this.lastOutgoingAt = summary.ts;
  }
}

function summarizeJsonRpcMessage(
  direction: "in" | "out",
  raw: string,
  parsed: JsonRpcMessage | undefined,
): JsonRpcMessageSummary {
  const bytes = Buffer.byteLength(raw, "utf-8");
  if (!parsed) return { direction, ts: Date.now(), bytes, method: null, id: null, kind: "invalid_json" };
  const record = parsed as unknown as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : null;
  const id = typeof record.id === "number" ? record.id : null;
  const kind: JsonRpcMessageSummary["kind"] = method ? (id !== null ? "request" : "notification") : "response";
  return { direction, ts: Date.now(), bytes, method, id, kind };
}

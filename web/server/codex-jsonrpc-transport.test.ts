import { describe, expect, it, vi } from "vitest";
import { JsonRpcTransport } from "./codex-jsonrpc-transport.js";
import { coreActionLatency } from "./core-action-latency.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

class MockWritableStream {
  chunks: string[] = [];
  private writer = {
    write: async (chunk: Uint8Array) => {
      this.chunks.push(new TextDecoder().decode(chunk));
    },
    releaseLock: () => {},
  };
  getWriter() {
    return this.writer;
  }
}

class MockReadableStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  readonly stream: ReadableStream<Uint8Array>;

  constructor() {
    this.stream = new ReadableStream({
      start: (controller) => {
        this.controller = controller;
      },
    });
  }

  push(data: string) {
    this.controller?.enqueue(new TextEncoder().encode(data));
  }

  close() {
    this.controller?.close();
  }
}

describe("JsonRpcTransport diagnostics", () => {
  it("captures close context, pending request methods, and recent RPC summaries", async () => {
    const stdin = new MockWritableStream();
    const stdout = new MockReadableStream();
    const transport = new JsonRpcTransport(stdin as never, stdout.stream, "session-1");
    const rawIncoming: string[] = [];
    const secondRawIncoming: string[] = [];
    transport.onRawIncoming((line) => rawIncoming.push(line));
    transport.onRawIncoming((line) => secondRawIncoming.push(line));

    const request = transport.request("skills/list", { forceReload: true });
    const rejected = request.promise.then(
      () => {
        throw new Error("expected request to reject");
      },
      (err: unknown) => err as Error,
    );
    await transport.notify("initialized", {});
    await tick();

    stdout.push(JSON.stringify({ method: "skills/changed", params: {} }) + "\n");
    await tick();
    stdout.close();

    const err = await rejected;
    expect(err.message).toBe("Transport closed");

    const diagnostics = transport.getCloseDiagnostics();
    expect(diagnostics).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        closeContext: "stdout_eof(buffer=0)",
        bufferedChars: 0,
        closeId: expect.any(String),
      }),
    );
    expect(diagnostics?.pendingRequests).toEqual([
      expect.objectContaining({ id: request.id, method: "skills/list", ageMs: expect.any(Number) }),
    ]);
    expect(diagnostics?.recentIncoming.at(-1)).toEqual(
      expect.objectContaining({ direction: "in", method: "skills/changed", kind: "notification" }),
    );
    expect(diagnostics?.recentOutgoing.map((entry) => entry.method)).toEqual(["skills/list", "initialized"]);
    expect(rawIncoming).toHaveLength(1);
    expect(secondRawIncoming).toEqual(rawIncoming);
  });
});

describe("JsonRpcTransport latency", () => {
  it("records each request round trip as a core action named after its method", async () => {
    // Codex RPC round trips are the coordinator-to-process hop that later
    // crosses the network, so every response feeds the core action stats.
    const recorded: Array<[string, number]> = [];
    const spy = vi.spyOn(coreActionLatency, "record").mockImplementation((action, ms) => {
      recorded.push([action, ms]);
    });
    const stdin = new MockWritableStream();
    const stdout = new MockReadableStream();
    const transport = new JsonRpcTransport(stdin as never, stdout.stream, "session-1");

    const request = transport.request("turn/start", {});
    await tick();
    stdout.push(JSON.stringify({ id: request.id, result: {} }) + "\n");
    await request.promise;
    spy.mockRestore();

    expect(recorded).toEqual([["codex-rpc turn/start", expect.any(Number)]]);
  });
});

/** A stdout stream whose chunks are all available before the transport reads. */
function bufferedStdout(chunks: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

/** Split `text` into pieces of `size` characters. */
function splitEvery(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += size) pieces.push(text.slice(i, i + size));
  return pieces;
}

async function runToClose(transport: JsonRpcTransport): Promise<void> {
  await new Promise<void>((resolve) => transport.onClose(resolve));
}

describe("JsonRpcTransport line buffering", () => {
  it("joins a message split across many chunks and dispatches it once", async () => {
    // Large Codex responses (such as thread/resume) arrive in many pipe
    // chunks; the transport must keep the pieces and handle the line once
    // its newline arrives, with the payload intact.
    const notifications: Array<[string, Record<string, unknown>]> = [];
    const message = JSON.stringify({ method: "thread/started", params: { text: "abc".repeat(5000) } });
    const transport = new JsonRpcTransport(
      new MockWritableStream() as never,
      bufferedStdout(splitEvery(message + "\n", 97)),
      "session-1",
    );
    transport.onNotification((method, params) => notifications.push([method, params]));
    await runToClose(transport);

    expect(notifications).toEqual([["thread/started", { text: "abc".repeat(5000) }]]);
    expect(transport.getCloseDiagnostics()?.bufferedChars).toBe(0);
  });

  it("handles several messages in one chunk and a chunk ending one line and starting the next, in order", async () => {
    const lines = [1, 2, 3, 4].map((n) => JSON.stringify({ method: "event", params: { n } }));
    const all = lines.join("\n") + "\n";
    // Chunk 1 holds lines 1-2 and the start of line 3; chunk 2 finishes line 3
    // and holds line 4 plus a blank line, which is ignored.
    const cut = lines[0].length + 1 + lines[1].length + 1 + 5;
    const transport = new JsonRpcTransport(
      new MockWritableStream() as never,
      bufferedStdout([all.slice(0, cut), all.slice(cut) + "\n"]),
      "session-1",
    );
    const seen: unknown[] = [];
    transport.onNotification((_method, params) => seen.push(params.n));
    await runToClose(transport);

    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it("decodes UTF-8 characters split across chunks", async () => {
    // Multi-byte characters can straddle a pipe chunk boundary; splitting the
    // encoded bytes mid-character must not corrupt the decoded text.
    const text = "héllo — 世界 🎉";
    const bytes = new TextEncoder().encode(JSON.stringify({ method: "event", params: { text } }) + "\n");
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const transport = new JsonRpcTransport(new MockWritableStream() as never, bufferedStdout(chunks), "session-1");
    const seen: unknown[] = [];
    transport.onNotification((_method, params) => seen.push(params.text));
    await runToClose(transport);

    expect(seen).toEqual([text]);
  });

  it("parses each incoming line once and hands the parsed message to raw listeners", async () => {
    // Diagnostics and traffic accounting reuse the dispatch parse instead of
    // parsing the same (possibly huge) line again.
    const parse = vi.spyOn(JSON, "parse");
    const line = JSON.stringify({ method: "event", params: { marker: "parse-once" } });
    const transport = new JsonRpcTransport(
      new MockWritableStream() as never,
      bufferedStdout([line + "\n"]),
      "session-1",
    );
    const raw: Array<[string, unknown]> = [];
    transport.onRawIncoming((rawLine, parsed) => raw.push([rawLine, parsed]));
    await runToClose(transport);
    const parsesOfLine = parse.mock.calls.filter(([text]) => text === line).length;
    parse.mockRestore();

    expect(parsesOfLine).toBe(1);
    expect(raw).toEqual([[line, { method: "event", params: { marker: "parse-once" } }]]);
  });

  it("skips lines that are not JSON objects and keeps handling later messages", async () => {
    // Invalid JSON and non-object JSON values are logged and recorded as
    // invalid_json, without closing the transport or dropping later lines.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const transport = new JsonRpcTransport(
      new MockWritableStream() as never,
      bufferedStdout(["{not json\n", "42\n", JSON.stringify({ method: "event", params: { n: 1 } }) + "\n"]),
      "session-1",
    );
    const raw: unknown[] = [];
    const seen: unknown[] = [];
    transport.onRawIncoming((_line, parsed) => raw.push(parsed));
    transport.onNotification((_method, params) => seen.push(params.n));
    await runToClose(transport);
    warn.mockRestore();

    expect(seen).toEqual([1]);
    expect(raw).toEqual([undefined, undefined, { method: "event", params: { n: 1 } }]);
    expect(transport.getCloseDiagnostics()?.recentIncoming.map((entry) => entry.kind)).toEqual([
      "invalid_json",
      "invalid_json",
      "notification",
    ]);
  });

  it("reports an unfinished line at EOF in the close diagnostics and rejects pending requests", async () => {
    const stdout = new MockReadableStream();
    const transport = new JsonRpcTransport(new MockWritableStream() as never, stdout.stream, "session-1");
    const request = transport.request("thread/resume", {});
    const rejected = request.promise.catch((err: Error) => err.message);
    await tick();
    stdout.push('{"id":1,"res');
    stdout.push("ult");
    await tick();
    stdout.close();

    expect(await rejected).toBe("Transport closed");
    expect(transport.getCloseContext()).toBe("stdout_eof(buffer=15)");
    expect(transport.getCloseDiagnostics()?.bufferedChars).toBe(15);
  });

  it("lets timers run while draining output that is already buffered", async () => {
    // Codex output that is already in the pipe is read without waiting, so a
    // long drain would otherwise starve timers, HTTP and WebSocket work (the
    // coordinator's health check timed out during large resumes). Each line
    // here takes ~25ms to handle, past the drain's time slice.
    const lines = [1, 2, 3].map((n) => JSON.stringify({ method: "event", params: { n } }) + "\n");
    let timerFired = false;
    const timerFiredBefore: boolean[] = [];
    const transport = new JsonRpcTransport(new MockWritableStream() as never, bufferedStdout(lines), "session-1");
    setTimeout(() => {
      timerFired = true;
    }, 0);
    transport.onNotification(() => {
      timerFiredBefore.push(timerFired);
      const until = performance.now() + 25;
      while (performance.now() < until) {}
    });
    await runToClose(transport);

    expect(timerFiredBefore).toHaveLength(3);
    expect(timerFiredBefore.at(-1)).toBe(true);
  });
});

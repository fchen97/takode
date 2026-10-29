import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { hasUsableNetwork } from "../network-availability.js";
import { dirname } from "node:path";
import { getEnrichedPath } from "../path-resolver.js";
import { inheritedLaunchEnv } from "../cli-launcher-env.js";
import { HOST_HOP_TIMING_METRIC } from "../latency-log.js";
import { performHostOperation } from "./host-operations.js";
import type { UpdatePreparation } from "./host-update.js";
import { HOST_LINK_FEATURES, HostLinkCodec, processBytes, processData } from "./host-link-codec.js";
import { spawnLocalTerminal, type TerminalProcess } from "../terminal-process.js";
import { thisMachineDetails } from "../machine-identity.js";
import { REMOTE_HOST_ENV } from "../../shared/remote-host-env.js";
import {
  API_PROXY_RELAYS_ENCODING_HEADER,
  HOST_HEARTBEAT_MS,
  HOST_LINK_PATH,
  HOST_LINK_STALE_MS,
  HOST_PROTOCOL_VERSION,
  type CoordinatorToHost,
  type HostCommand,
  type HostLinkFeature,
  type HostMachineSettings,
  type HostProcessEvent,
  type HostProgramRole,
  type HostRequest,
  type HostResponse,
  type HostToCoordinator,
} from "../../shared/host-protocol.js";

/** The part of a WebSocket the host agent needs; Bun's and the browser's both fit. */
export interface AgentSocket {
  readyState: number;
  /** How binary frames arrive; set to `arraybuffer` where the socket supports it. */
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface HostAgentOptions {
  /** Base URL of the coordinator, e.g. `https://takode.example.com` or `http://127.0.0.1:3456`. */
  coordinatorUrl: string;
  /** Token issued when this host was registered on the coordinator. */
  token: string;
  /** Loopback port of this host's API proxy; agent CLIs on this host use it as COMPANION_PORT. */
  apiProxyPort: number;
  /**
   * Programs to run by role, from the node's command line (`--claude`,
   * `--codex`). They win over the machine settings the coordinator sends.
   */
  commands?: Partial<Record<HostProgramRole, string>>;
  /** Codex launch preparation; the real one (`prepareCodexSpawn`) unless a test supplies another. */
  prepareCodexLaunch?: (
    sessionId: string,
    info: unknown,
    options: Record<string, unknown>,
  ) => Promise<{
    spawnCmd: string[];
    spawnEnv: Record<string, string | undefined>;
    spawnCwd: string | undefined;
    [setting: string]: unknown;
  }>;
  /** Git commit this node's Takode checkout was at when it started, reported to the coordinator. */
  build?: string | null;
  /** The name this machine keeps for itself, or null when it has none yet. */
  machineName?: string | null;
  /** Keep a new name for this machine: the registration name when it had none, or a rename. */
  saveMachineName?: (name: string) => Promise<void>;
  /**
   * Accept the coordinator's `update`: switch this machine's Takode checkout to
   * the named commit and restart. It returns only if the switch failed (by
   * throwing); omit it to keep the coordinator from updating this host.
   */
  update?: (commit: string) => Promise<void>;
  /**
   * Answer the coordinator's `prepare_update` before it stops this host's
   * sessions for `update`: whether this machine can switch to the commit
   * (with `bundle`, the Git objects the coordinator sent for it), without
   * changing what runs. Throws when it cannot.
   */
  prepareUpdate?: (commit: string, bundle: Buffer | null) => Promise<UpdatePreparation>;
  /** Link features to offer the coordinator; all this build knows unless a test stands in for an older host. */
  linkFeatures?: readonly HostLinkFeature[];
  /** First reconnect delay after a link drop; doubles up to 15s (2s for a coordinator on this machine). */
  reconnectDelayMs?: number;
  /** Overrides for tests. */
  connect?: (url: string, headers: Record<string, string>) => AgentSocket;
  spawnProcess?: (command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) => ChildProcess;
  log?: (message: string) => void;
}

/** A process event as the host keeps it until acknowledged: output in base64, converted for each link when sent. */
type HostedEvent =
  | Exclude<HostProcessEvent, { kind: "stdout" | "stderr" }>
  | { kind: "stdout" | "stderr"; data: string };

interface HostedProcess {
  /** Input, signals and size of the running process; null when it could not start. */
  control: ProcessControl | null;
  nextSeq: number;
  /** Events the coordinator has not acknowledged yet, oldest first. */
  pending: { seq: number; event: HostedEvent }[];
  /**
   * Acknowledged stdout after its last newline: the start of a line the
   * coordinator has not seen whole. A new coordinator receives it again.
   */
  unfinishedLine: Buffer;
  exited: boolean;
}

interface ProcessControl {
  write(data: Buffer): void;
  end(): void;
  kill(signal: NodeJS.Signals): void;
  resize?(cols: number, rows: number): void;
}

const OPEN = 1;
const MAX_RECONNECT_DELAY_MS = 15_000;
/** A coordinator on this machine costs nothing to retry, and agent CLIs here wait for the link. */
const MAX_LOOPBACK_RECONNECT_DELAY_MS = 2_000;

/**
 * The `takode node` side of a host link. It dials out to the coordinator, runs
 * the processes the coordinator asks for, and keeps their output until the
 * coordinator acknowledges it, replaying it after any reconnect.
 */
export class HostAgent {
  readonly instanceId = randomUUID();
  private socket: AgentSocket | null = null;
  /** Encoding of the current socket's messages; each connection starts plain. */
  private codec = new HostLinkCodec();
  private coordinatorInstanceId: string | null = null;
  /** Highest coordinator epoch seen by this `takode node` process. */
  private highestEpoch = 0;
  private appliedCommandSeq = 0;
  private readonly processes = new Map<string, HostedProcess>();
  /** Launches prepared by `prepare_codex`, waiting for their `spawn` command. */
  private readonly preparedLaunches = new Map<
    string,
    { argv: string[]; env: Record<string, string | undefined>; cwd: string | undefined }
  >();
  private lastHeardAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private stopped = false;
  private updating = false;
  /** This machine's settings as the coordinator last sent them. */
  private machineSettings: HostMachineSettings = { claudeBinary: "", codexBinary: "", worktreeRoot: "" };
  private machineName: string | null;
  /** The coordinator's last reason for refusing the link, logged once until the link opens. */
  private lastRefusal: string | null = null;
  private readonly log: (message: string) => void;

  constructor(private readonly options: HostAgentOptions) {
    this.log = options.log ?? ((message) => console.log(`[takode node] ${message}`));
    this.machineName = options.machineName ?? null;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = isLoopbackHost(new URL(options.coordinatorUrl).hostname)
      ? MAX_LOOPBACK_RECONNECT_DELAY_MS
      : MAX_RECONNECT_DELAY_MS;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.heartbeat = setInterval(() => this.tick(), HOST_HEARTBEAT_MS);
  }

  /** Stop reconnecting and end every hosted process. */
  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Host stopping");
    this.socket = null;
    for (const hosted of this.processes.values()) hosted.control?.kill("SIGTERM");
  }

  get connected(): boolean {
    return this.socket?.readyState === OPEN && this.coordinatorInstanceId !== null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = linkUrl(this.options.coordinatorUrl);
    const headers = { Authorization: `Bearer ${this.options.token}` };
    const socket = this.options.connect
      ? this.options.connect(url, headers)
      : (new WebSocket(url, { headers } as unknown as string[]) as unknown as AgentSocket);
    this.socket = socket;
    this.codec = new HostLinkCodec();
    socket.binaryType = "arraybuffer";
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.lastRefusal = null;
      this.lastHeardAt = Date.now();
      const details = thisMachineDetails();
      this.send({
        t: "hello",
        protocol: HOST_PROTOCOL_VERSION,
        instanceId: this.instanceId,
        appliedCommandSeq: this.appliedCommandSeq,
        appliedFrom: this.coordinatorInstanceId,
        homeDir: homedir(),
        machineName: this.machineName,
        platform: details.platform ?? undefined,
        ...(details.user ? { user: details.user } : {}),
        processes: [...this.processes.keys()],
        features: [...(this.options.linkFeatures ?? HOST_LINK_FEATURES)],
        ...(this.options.build ? { build: this.options.build } : {}),
        ...(this.options.update ? { autoUpdate: true } : {}),
        ...(this.options.update && this.options.prepareUpdate ? { preparesUpdates: true } : {}),
        ...(this.options.commands && Object.keys(this.options.commands).length > 0
          ? { commandOverrides: this.options.commands }
          : {}),
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastHeardAt = Date.now();
      const frame =
        event.data instanceof ArrayBuffer || event.data instanceof Uint8Array ? event.data : String(event.data);
      let message: CoordinatorToHost;
      try {
        message = JSON.parse(this.codec.decode(frame)) as CoordinatorToHost;
      } catch (error) {
        if (typeof frame === "string") return;
        // A compressed message that does not decode means the two sides no
        // longer share the compression history; start the connection over.
        this.log(`Could not decode a message from the coordinator; reconnecting: ${errorMessage(error)}`);
        this.socket = null;
        socket.close(4005, "Undecodable message");
        this.scheduleReconnect();
        return;
      }
      this.handleMessage(message);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!opened) void this.explainRefusal(url, headers);
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // `onclose` follows and schedules the reconnect.
    };
  }

  /**
   * A WebSocket the coordinator refused before it opened does not say why, so
   * ask the same address over plain HTTP and log the answer, such as a host
   * token it does not know or a tunnel that reaches the wrong port.
   */
  private async explainRefusal(url: string, headers: Record<string, string>): Promise<void> {
    let reason: string;
    try {
      const response = await fetch(url.replace(/^ws/, "http"), { headers });
      // 400 means the coordinator would have taken an upgrade, so the link failed for another reason.
      if (response.status === 400) return;
      reason = `${response.status}: ${(await response.text()).slice(0, 500)}`;
    } catch {
      return; // Unreachable; the reconnect message already says the link is down.
    }
    if (reason === this.lastRefusal) return;
    this.lastRefusal = reason;
    this.log(`Coordinator refused the link (${reason})`);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
    this.log(`Coordinator link down; reconnecting in ${delay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(message: CoordinatorToHost): void {
    switch (message.t) {
      case "welcome":
        if (message.epoch < this.highestEpoch) {
          // A coordinator that was replaced by a newer start must not drive processes here.
          this.log(`Refusing coordinator epoch ${message.epoch}; epoch ${this.highestEpoch} has already started`);
          const socket = this.socket;
          this.socket = null;
          socket?.close(4004, "Superseded coordinator");
          this.scheduleReconnect();
          return;
        }
        this.highestEpoch = message.epoch;
        // A machine keeps its own name; one without a name takes the one it was registered with.
        if (!this.machineName && message.machineName) this.keepMachineName(message.machineName);
        // Everything the coordinator sent after the welcome, and everything sent from here on, may use them.
        this.codec.enable(message.features);
        this.handleWelcome(message.instanceId, message.received);
        return;
      case "command":
        if (message.seq <= this.appliedCommandSeq) {
          this.send({ t: "command_ack", seq: message.seq });
          return;
        }
        if (message.seq !== this.appliedCommandSeq + 1) return; // A gap is resent after the next welcome.
        this.apply(message.command);
        this.appliedCommandSeq = message.seq;
        this.send({ t: "command_ack", seq: message.seq });
        return;
      case "event_ack": {
        const hosted = this.processes.get(message.procId);
        if (!hosted) return;
        for (const { seq, event } of hosted.pending) {
          if (seq > message.seq) break;
          if (event.kind === "stdout") hosted.unfinishedLine = lineRemainder(hosted.unfinishedLine, event.data);
        }
        hosted.pending = hosted.pending.filter((pending) => pending.seq > message.seq);
        this.forgetIfDone(message.procId, hosted);
        return;
      }
      case "request":
        void this.answer(message.id, message.request);
        return;
      case "rejected":
        this.log(`Coordinator rejected this host: ${message.reason}`);
        this.stop();
        return;
      case "heartbeat":
        return;
      case "update":
        void this.applyUpdate(message.commit);
        return;
      case "settings":
        this.machineSettings = message.settings;
        return;
      case "machine_name":
        this.keepMachineName(message.name);
        return;
    }
  }

  private keepMachineName(name: string): void {
    if (name === this.machineName) return;
    this.machineName = name;
    this.log(`This machine is named ${name}`);
    this.options
      .saveMachineName?.(name)
      .catch((error) => this.log(`Saving the machine name failed: ${errorMessage(error)}`));
  }

  private async applyUpdate(commit: string): Promise<void> {
    if (!this.options.update || this.updating) return;
    this.updating = true;
    this.log(`Coordinator asked to update to ${commit}`);
    try {
      await this.options.update(commit);
    } catch (error) {
      this.log(`Update to ${commit} failed: ${errorMessage(error)}`);
      this.send({ t: "update_failed", commit, error: errorMessage(error) });
    } finally {
      this.updating = false;
    }
  }

  private handleWelcome(coordinatorInstanceId: string, received: Record<string, number>): void {
    this.reconnectDelayMs = this.options.reconnectDelayMs ?? 1_000;
    if (this.coordinatorInstanceId !== coordinatorInstanceId) {
      this.adoptBy(coordinatorInstanceId, received);
      return;
    }
    for (const [procId, hosted] of this.processes) {
      const lastReceived = received[procId];
      if (lastReceived === undefined) {
        // The coordinator no longer tracks this process.
        hosted.control?.kill("SIGTERM");
        this.processes.delete(procId);
        continue;
      }
      hosted.pending = hosted.pending.filter((pending) => pending.seq > lastReceived);
      for (const pending of hosted.pending) {
        this.send({ t: "event", procId, seq: pending.seq, event: pending.event });
      }
    }
    this.log("Reconnected to coordinator");
  }

  /**
   * A new coordinator instance: keep the processes it takes over and end the
   * rest. Each kept process replays what the old coordinator did not
   * acknowledge, after the partial line it saw only part of, numbered from 1
   * for the new coordinator. Commands are numbered from 1 again too.
   */
  private adoptBy(coordinatorInstanceId: string, received: Record<string, number>): void {
    const restarted = this.coordinatorInstanceId !== null;
    this.coordinatorInstanceId = coordinatorInstanceId;
    this.appliedCommandSeq = 0;
    this.preparedLaunches.clear();
    let kept = 0;
    for (const [procId, hosted] of this.processes) {
      if (!(procId in received)) {
        hosted.control?.kill("SIGTERM");
        this.processes.delete(procId);
        continue;
      }
      kept++;
      const events = hosted.pending.map((pending) => pending.event);
      if (hosted.unfinishedLine.length > 0) {
        events.unshift({ kind: "stdout", data: hosted.unfinishedLine.toString("base64") });
      }
      hosted.unfinishedLine = Buffer.alloc(0);
      hosted.pending = events.map((event, index) => ({ seq: index + 1, event }));
      hosted.nextSeq = hosted.pending.length + 1;
      for (const { seq, event } of hosted.pending) this.send({ t: "event", procId, seq, event });
    }
    this.log(restarted ? `Coordinator restarted; it took over ${kept} process(es)` : "Connected to coordinator");
  }

  private async answer(id: string, request: HostRequest): Promise<void> {
    try {
      const response =
        request.kind === "prepare_codex"
          ? await this.prepareCodex(request)
          : request.kind === "prepare_update"
            ? await this.prepareUpdate(request)
            : await performHostRequest(request);
      this.send({ t: "response", id, ok: true, response });
    } catch (error) {
      this.send({ t: "response", id, ok: false, error: errorMessage(error) });
    }
  }

  private async prepareUpdate(request: Extract<HostRequest, { kind: "prepare_update" }>): Promise<HostResponse> {
    if (!this.options.update || !this.options.prepareUpdate) throw new Error("This host does not accept updates");
    const bundle = request.bundle === undefined ? null : Buffer.from(request.bundle, "base64");
    if (bundle) this.log(`Importing ${Math.ceil(bundle.length / 1024)} KB of Git objects for ${request.commit}`);
    return { kind: "prepare_update", ...(await this.options.prepareUpdate(request.commit, bundle)) };
  }

  /**
   * Prepare a Codex launch here, with this host's Codex binary, home and
   * configuration, and keep the command for the `spawn` that follows.
   */
  private async prepareCodex(request: Extract<HostRequest, { kind: "prepare_codex" }>): Promise<HostResponse> {
    const requested = request.options as Record<string, unknown>;
    const options = {
      ...requested,
      // The coordinator's binary and Codex home paths describe its own machine.
      codexBinary: this.program("codex"),
      codexHome: undefined,
      // Named here too, not only at spawn, so the session's Codex config passes it to commands.
      env: { ...(requested.env as Record<string, string> | undefined), [REMOTE_HOST_ENV]: "1" },
    };
    const prepare = this.options.prepareCodexLaunch ?? prepareCodexWithThisInstall;
    const spec = await prepare(request.sessionId, request.info, options);
    const launchId = randomUUID();
    this.preparedLaunches.set(launchId, { argv: spec.spawnCmd, env: spec.spawnEnv, cwd: spec.spawnCwd });
    const { spawnCmd: _cmd, spawnEnv: _env, spawnCwd: _cwd, ...adapterSettings } = spec;
    return { kind: "prepare_codex", launchId, adapterSettings: adapterSettings as Record<string, unknown> };
  }

  private apply(command: HostCommand): void {
    switch (command.kind) {
      case "spawn":
        this.spawn(command);
        return;
      case "spawn_terminal":
        this.spawnTerminal(command);
        return;
      case "write_file": {
        // `~/` stands for this host's home when the coordinator did not know it yet.
        const path = command.path.startsWith("~/") ? `${homedir()}${command.path.slice(1)}` : command.path;
        void mkdir(dirname(path), { recursive: true })
          .then(() => writeFile(path, Buffer.from(command.data, "base64")))
          .catch((error) => this.log(`Could not write ${path}: ${errorMessage(error)}`));
        return;
      }
      case "stdin":
        this.processes.get(command.procId)?.control?.write(processBytes(command));
        return;
      case "stdin_end":
        this.processes.get(command.procId)?.control?.end();
        return;
      case "resize":
        this.processes.get(command.procId)?.control?.resize?.(command.cols, command.rows);
        return;
      case "kill":
        this.processes.get(command.procId)?.control?.kill(command.signal as NodeJS.Signals);
        return;
    }
  }

  private spawn(command: Extract<HostCommand, { kind: "spawn" }>): void {
    const hosted: HostedProcess = {
      control: null,
      nextSeq: 1,
      pending: [],
      unfinishedLine: Buffer.alloc(0),
      exited: false,
    };
    this.processes.set(command.procId, hosted);
    const port = String(this.options.apiProxyPort);
    const prepared = command.preparedLaunchId ? this.preparedLaunches.get(command.preparedLaunchId) : undefined;
    if (command.preparedLaunchId) this.preparedLaunches.delete(command.preparedLaunchId);
    if (command.preparedLaunchId && !prepared) {
      this.emit(command.procId, { kind: "error", message: "The prepared launch is gone; the host may have restarted" });
      this.emit(command.procId, { kind: "exit", code: null, signal: null });
      return;
    }
    // A prepared Codex launch carries its environment here; its spawn command sends none.
    const launchEnv = prepared?.env ?? command.env;
    const env: NodeJS.ProcessEnv = {
      ...(command.fullEnv
        ? command.env
        : {
            ...inheritedLaunchEnv(process.env),
            ...launchEnv,
            // Like on the coordinator, agents find Takode's CLI wrappers and the user's
            // shell tools first. A prepared Codex launch already built this PATH here.
            ...(prepared ? {} : { PATH: getEnrichedPath() }),
          }),
      // Agent CLIs on this host reach the coordinator through the local API proxy,
      // which holds their calls while the coordinator restarts.
      COMPANION_PORT: port,
      // Only leaders carry TAKODE_API_PORT; workers must not gain it.
      ...(launchEnv.TAKODE_API_PORT ? { TAKODE_API_PORT: port } : {}),
      // A coordinator on another machine holds all Takode data, so CLIs here
      // must not answer from this machine's files.
      ...(command.fullEnv ? {} : { [REMOTE_HOST_ENV]: "1" }),
    };
    const program = prepared ? prepared.argv[0]! : this.program(command.command);
    const programArgs = prepared ? prepared.argv.slice(1) : command.args;
    const cwd = prepared ? prepared.cwd : command.cwd;
    const start = this.options.spawnProcess ?? defaultSpawn;
    let child: ChildProcess;
    try {
      child = start(program, programArgs, { ...(cwd ? { cwd } : {}), env });
    } catch (error) {
      this.emit(command.procId, { kind: "error", message: errorMessage(error) });
      this.emit(command.procId, { kind: "exit", code: null, signal: null });
      return;
    }
    hosted.control = {
      write: (data) => child.stdin?.write(data),
      end: () => child.stdin?.end(),
      kill: (signal) => child.kill(signal),
    };
    let spawned = false;
    child.once("spawn", () => {
      spawned = true;
      this.emit(command.procId, { kind: "spawned", ...(child.pid ? { pid: child.pid } : {}) });
    });
    child.stdout?.on("data", (chunk: Buffer) =>
      this.emit(command.procId, { kind: "stdout", data: chunk.toString("base64") }),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      this.emit(command.procId, { kind: "stderr", data: chunk.toString("base64") }),
    );
    child.once("error", (error) => {
      this.emit(command.procId, { kind: "error", message: error.message });
      // A process that never started reports no close of its own.
      if (!spawned) this.emit(command.procId, { kind: "exit", code: null, signal: null });
    });
    child.once("close", (code, signal) => this.emit(command.procId, { kind: "exit", code, signal }));
  }

  private spawnTerminal(command: Extract<HostCommand, { kind: "spawn_terminal" }>): void {
    const hosted: HostedProcess = {
      control: null,
      nextSeq: 1,
      pending: [],
      unfinishedLine: Buffer.alloc(0),
      exited: false,
    };
    this.processes.set(command.procId, hosted);
    let terminal: TerminalProcess;
    try {
      terminal = spawnLocalTerminal(command.cwd, command.cols, command.rows, {
        onData: (chunk) => this.emit(command.procId, { kind: "stdout", data: Buffer.from(chunk).toString("base64") }),
        onExit: (code) => this.emit(command.procId, { kind: "exit", code, signal: null }),
      });
    } catch (error) {
      // For example, the folder does not exist on this host.
      this.emit(command.procId, { kind: "error", message: errorMessage(error) });
      this.emit(command.procId, { kind: "exit", code: null, signal: null });
      return;
    }
    hosted.control = {
      write: (data) => terminal.write(data.toString("utf-8")),
      end: () => {},
      kill: (signal) => terminal.kill(signal),
      resize: (cols, rows) => terminal.resize(cols, rows),
    };
    this.emit(command.procId, { kind: "spawned" });
  }

  /**
   * The program to run for a name the coordinator sent: for a known role, the
   * node's command-line override, else this machine's setting, else the name.
   */
  private program(name: string): string {
    if (name !== "claude" && name !== "codex") return name;
    return this.options.commands?.[name] || this.machineSettings[`${name}Binary`] || name;
  }

  /** Record an event for the coordinator and send it if the link is up. */
  private emit(procId: string, event: HostedEvent): void {
    const hosted = this.processes.get(procId);
    if (!hosted || hosted.exited) return;
    if (event.kind === "exit") hosted.exited = true;
    const seq = hosted.nextSeq++;
    hosted.pending.push({ seq, event });
    if (this.connected) this.send({ t: "event", procId, seq, event });
  }

  private forgetIfDone(procId: string, hosted: HostedProcess): void {
    if (hosted.exited && hosted.pending.length === 0) this.processes.delete(procId);
  }

  private tick(): void {
    if (!this.socket || this.socket.readyState !== OPEN) return;
    if (Date.now() - this.lastHeardAt > HOST_LINK_STALE_MS) {
      const socket = this.socket;
      this.socket = null;
      socket.close(4002, "Heartbeat timeout");
      this.scheduleReconnect();
      return;
    }
    this.send({ t: "heartbeat", network: hasUsableNetwork() });
  }

  /** Send a message in the current socket's encoding, with process output as text where the coordinator reads it. */
  private send(message: HostToCoordinator): void {
    if (this.socket?.readyState !== OPEN) return;
    if (message.t === "event" && (message.event.kind === "stdout" || message.event.kind === "stderr")) {
      const { kind, data } = message.event;
      if (data !== undefined) message = { ...message, event: { kind, ...processData(data, this.codec.has("text")) } };
    }
    this.socket.send(this.codec.encode(message));
  }
}

/** How long agent CLIs on a host wait for an unreachable coordinator, e.g. one that is restarting. */
const COORDINATOR_WAIT_MS = 120_000;
const COORDINATOR_POLL_MS = 250;

/**
 * Serve the coordinator's `/api` on a loopback port of this host, so agent CLIs
 * running here keep using `http://localhost:$COMPANION_PORT/api` unchanged.
 * Requests and responses pass through as-is, including session auth headers
 * and the Server-Timing header the CLI latency log reads. Response bodies are
 * relayed still encoded, and the proxy tells the coordinator so, which lets it
 * gzip large answers across the link; the agent CLI decodes them here.
 *
 * Sessions here keep running while the coordinator restarts, so their CLI
 * calls wait for it (up to `waitMs`, or until the caller gives up) instead of
 * failing: requests are held while `coordinatorConnected` reports the host
 * link down, and sent again when the connection is refused.
 */
export function startApiProxy(options: {
  coordinatorUrl: string;
  port: number;
  coordinatorConnected?: () => boolean;
  waitMs?: number;
}): { port: number; stop: () => void } {
  const base = options.coordinatorUrl.replace(/\/+$/, "");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    // Requests may wait for the coordinator far longer than Bun's 10s default.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.set(API_PROXY_RELAYS_ENCODING_HEADER, "1");
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      const started = performance.now();
      let response: Response;
      try {
        response = await forwardWhenReachable(
          `${base}${url.pathname}${url.search}`,
          // Bun's fetch would decode the body but keep its Content-Encoding and Content-Length.
          { method: request.method, headers, body, redirect: "manual", decompress: false } as RequestInit,
          {
            connected: options.coordinatorConnected ?? (() => true),
            deadline: Date.now() + (options.waitMs ?? COORDINATOR_WAIT_MS),
            signal: request.signal,
          },
        );
      } catch (error) {
        // JSON like the coordinator's own errors, so agent CLIs show the reason instead of "Bad Gateway".
        // Bun's fetch gives up on an answer after 5 minutes; the coordinator was reached but did not answer.
        const problem =
          (error as { name?: string }).name === "TimeoutError"
            ? "did not answer in time"
            : `is unreachable: ${errorMessage(error)}`;
        return Response.json({ error: `The Takode coordinator at ${base} ${problem}` }, { status: 502 });
      }
      // Report the hop, including any wait for the coordinator, so the CLI
      // latency log can separate it from local overhead.
      const relayed = new Headers(response.headers);
      relayed.append("server-timing", `${HOST_HOP_TIMING_METRIC};dur=${(performance.now() - started).toFixed(1)}`);
      return new Response(response.body, { status: response.status, headers: relayed });
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

async function forwardWhenReachable(
  url: string,
  init: RequestInit,
  wait: { connected: () => boolean; deadline: number; signal: AbortSignal },
): Promise<Response> {
  const waiting = () => Date.now() < wait.deadline && !wait.signal.aborted;
  for (;;) {
    while (!wait.connected() && waiting()) await Bun.sleep(COORDINATOR_POLL_MS);
    try {
      return await fetch(url, init);
    } catch (error) {
      // A refused connection never reached the coordinator, so even a write is safe to send again.
      if ((error as { code?: string }).code !== "ConnectionRefused" || !waiting()) throw error;
      await Bun.sleep(COORDINATOR_POLL_MS);
    }
  }
}

/**
 * Refuse to send the host token and session traffic unencrypted to another
 * machine. Plain http is accepted only for a coordinator on this machine (or
 * reached through a local tunnel), unless the caller explicitly allows it, for
 * example inside a private network that already encrypts traffic.
 */
export function insecureCoordinatorUrlProblem(coordinatorUrl: string, allowInsecure: boolean): string | null {
  let url: URL;
  try {
    url = new URL(coordinatorUrl);
  } catch {
    return `Not a valid coordinator URL: ${coordinatorUrl}`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") return `The coordinator URL must start with https:// or http://: ${coordinatorUrl}`;
  if (allowInsecure || isLoopbackHost(url.hostname)) return null;
  return (
    `${coordinatorUrl} is not encrypted, so the host token and session traffic would cross the network in the clear. ` +
    "Use an https:// coordinator URL, a local tunnel (http://127.0.0.1:...), or pass --allow-insecure if the network already encrypts traffic."
  );
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127\./.test(hostname);
}

/** Perform one coordinator request on this machine. */
export async function performHostRequest(request: HostRequest): Promise<HostResponse> {
  switch (request.kind) {
    case "exec":
      return runShell(request);
    case "read_file": {
      const handle = await open(request.path, "r");
      try {
        const size = (await handle.stat()).size;
        const length = Math.min(size, request.maxBytes);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        return { kind: "read_file", data: buffer.toString("base64"), truncated: size > request.maxBytes };
      } finally {
        await handle.close();
      }
    }
    case "stat": {
      const info = await stat(request.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      return {
        kind: "stat",
        stat: info
          ? { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs }
          : null,
      };
    }
    case "prepare_codex":
      throw new Error("Codex launches are prepared by the host agent");
    case "prepare_update":
      throw new Error("Updates are prepared by the host agent");
    case "operation":
      return { kind: "operation", result: await performHostOperation(request.name, request.args) };
    case "write_file":
      await mkdir(dirname(request.path), { recursive: true });
      await writeFile(request.path, Buffer.from(request.data, "base64"), { mode: request.mode });
      return { kind: "write_file" };
  }
}

function runShell(request: Extract<HostRequest, { kind: "exec" }>): Promise<HostResponse> {
  return new Promise((resolve, reject) => {
    const child = spawnChild("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      if (bytes >= request.maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = request.maxOutputBytes - bytes;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) truncated = true;
      bytes += kept.length;
      target.push(kept);
    };
    child.stdout?.on("data", capture(out));
    child.stderr?.on("data", capture(err));
    const timer = setTimeout(() => child.kill("SIGKILL"), request.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        kind: "exec",
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
        truncated,
      });
    });
  });
}

async function prepareCodexWithThisInstall(sessionId: string, info: unknown, options: Record<string, unknown>) {
  const { prepareCodexSpawn } = await import("../cli-launcher-codex.js");
  return prepareCodexSpawn(
    sessionId,
    info as Parameters<typeof prepareCodexSpawn>[1],
    options as Parameters<typeof prepareCodexSpawn>[2],
  );
}

/** The bytes after the last newline of `previous` followed by the base64 `data`. */
function lineRemainder(previous: Buffer, data: string): Buffer {
  const chunk = Buffer.from(data, "base64");
  const newline = chunk.lastIndexOf(0x0a);
  return newline === -1 ? Buffer.concat([previous, chunk]) : chunk.subarray(newline + 1);
}

function linkUrl(coordinatorUrl: string): string {
  const url = new URL(coordinatorUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = HOST_LINK_PATH;
  url.search = "";
  return url.toString();
}

function defaultSpawn(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) {
  return spawnChild(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

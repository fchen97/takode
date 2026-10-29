/**
 * The Takode server is the only writer of quest data. Quest CLI mutations go
 * through this client instead of touching the store files, so a CLI that runs
 * on another machine can never write a divergent local copy.
 */

/** Generous on purpose: once the request is sent, the server owns the write. */
export const QUEST_SERVER_TIMEOUT_MS = 30_000;

export type QuestServerResponse<T> = { value: T; headers: Headers };

/**
 * Reads give up on the server sooner than writes and fall back to the local
 * store, except on a remote host, which has no copy of the server's store.
 */
export const QUEST_SERVER_READ_TIMEOUT_MS = 5_000;

export interface QuestServerClient {
  /** Send one request to `/api<path>` and return the parsed JSON body, or exit with a clear error. */
  request<T>(method: string, path: string, body?: unknown): Promise<QuestServerResponse<T>>;
  /**
   * GET `/api<path>` from the server's cached store. A server that answers is
   * authoritative: this returns its data, `null` for a 404 when `allowNotFound`
   * is set, and exits with any other error. Only when no server is configured
   * or none answers does it return undefined, so the caller reads this
   * machine's store; on a remote host, which has none of the server's data, it
   * exits instead.
   */
  read<T>(path: string, options?: { allowNotFound?: boolean }): Promise<T | null | undefined>;
}

/**
 * Build the client for one CLI invocation. `port` is undefined when neither
 * COMPANION_PORT nor session credentials name a server; writes then fail
 * instead of guessing a server whose data may not belong to this caller.
 */
export function createQuestServerClient(deps: {
  port: string | undefined;
  authHeaders: (extra?: Record<string, string>) => Record<string, string>;
  die: (message: string) => never;
  /** This CLI runs on a remote host: the coordinator holds the store, so reads never fall back to local files. */
  remoteHost?: boolean;
  /** Whether this machine has a quest store to fall back to; reads without one fail instead of creating one. */
  hasLocalStore?: () => Promise<boolean>;
}): QuestServerClient {
  /** No server answered: the caller reads this machine's store, if it has one. */
  async function fallBackToLocal(problem: string): Promise<undefined> {
    if (deps.remoteHost) deps.die(remoteHostNeedsServer(problem));
    if (deps.hasLocalStore && !(await deps.hasLocalStore())) {
      deps.die(
        `${problem} This machine has no quest store of its own to read either: ` +
          "run the command from a Takode session or set COMPANION_PORT to the server's port.",
      );
    }
    return undefined;
  }

  return {
    async request<T>(method: string, path: string, body?: unknown): Promise<QuestServerResponse<T>> {
      const port = deps.port;
      if (!port) {
        deps.die(
          "No Takode server is configured for this command. Quest changes are written by the Takode server: " +
            "run it from a Takode session or set COMPANION_PORT to the server's port.",
        );
      }
      const isForm = body instanceof FormData;
      const headers = deps.authHeaders(body === undefined || isForm ? {} : { "Content-Type": "application/json" });
      let response: Response;
      try {
        response = await fetch(`http://localhost:${port}/api${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }),
          signal: AbortSignal.timeout(QUEST_SERVER_TIMEOUT_MS),
        });
      } catch (error) {
        deps.die(describeRequestFailure(error, port));
      }
      if (!response.ok) deps.die(await responseError(response));
      return { value: (await response.json()) as T, headers: response.headers };
    },
    async read<T>(path: string, options: { allowNotFound?: boolean } = {}): Promise<T | null | undefined> {
      const port = deps.port;
      if (!port) return fallBackToLocal("No Takode server is configured for this command.");
      let response: Response;
      let text: string;
      try {
        response = await fetch(`http://localhost:${port}/api${path}`, {
          headers: deps.authHeaders(),
          // On a remote host the node's proxy holds requests while the coordinator restarts.
          signal: AbortSignal.timeout(deps.remoteHost ? QUEST_SERVER_TIMEOUT_MS : QUEST_SERVER_READ_TIMEOUT_MS),
        });
        text = await response.text();
      } catch (error) {
        // Reads are safe to answer from the local store when the server on this machine is down.
        return fallBackToLocal(describeReadFailure(error, port));
      }
      let body: { error?: unknown } | null;
      try {
        body = JSON.parse(text) as { error?: unknown } | null;
      } catch {
        // Not an answer from this route: an older server without it (its frontend page or a
        // plain 404), or a remote host's proxy reporting that the coordinator is unreachable.
        return fallBackToLocal(
          response.ok || response.status === 404
            ? "The Takode server does not support this read yet; restart it on the current build."
            : text.trim() || `The Takode server returned HTTP ${response.status}.`,
        );
      }
      if (response.ok) return body as T;
      if (response.status === 404 && options.allowNotFound) return null;
      const error = body?.error;
      deps.die(typeof error === "string" && error ? error : `The Takode server returned HTTP ${response.status}.`);
    },
  };
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) return parsed.error;
  } catch {
    // Not JSON, e.g. the node's proxy reporting an unreachable coordinator.
  }
  return text.trim() || response.statusText || `HTTP ${response.status}`;
}

function remoteHostNeedsServer(problem: string): string {
  return `${problem} This machine is a remote Takode host and keeps no copy of the quest store, so quest reads need the coordinator.`;
}

function describeReadFailure(error: unknown, port: string): string {
  const name = (error as { name?: string } | null)?.name;
  const server = `the Takode server at http://localhost:${port}`;
  return name === "TimeoutError" || name === "AbortError"
    ? `${capitalize(server)} did not answer within ${QUEST_SERVER_TIMEOUT_MS / 1000}s.`
    : `Cannot reach ${server}.`;
}

function describeRequestFailure(error: unknown, port: string): string {
  const server = `the Takode server at http://localhost:${port}`;
  const name = (error as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return (
      `${capitalize(server)} did not answer within ${QUEST_SERVER_TIMEOUT_MS / 1000}s. ` +
      "The change may still have been applied: check with `quest show` before retrying."
    );
  }
  return (
    `Cannot reach ${server}. Quest changes are written by the server: ` +
    "start Takode (or correct COMPANION_PORT) and retry."
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

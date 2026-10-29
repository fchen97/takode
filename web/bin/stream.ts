#!/usr/bin/env bun

/**
 * `stream`: durable operational context kept by the Takode server.
 *
 * Commands run on the server that owns the streams, so they work the same on a
 * remote host as on the server's machine. Reading commands fall back to this
 * machine's streams when no server is named or reachable; writing commands
 * never do, and nothing does on a remote host, whose coordinator holds the
 * only copy.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isStreamWriteCommand,
  streamCommandInputFiles,
  streamCommandNeedsDefaultScope,
} from "../server/stream-command-args.js";
import type { StreamCommandResult } from "../server/stream-command.js";
import { projectStreamScope } from "../server/stream-project-scope.js";
import { runsOnRemoteHost } from "../shared/remote-host-env.js";
import {
  STREAM_SERVER_COMMAND_TIMEOUT_MS,
  type StreamServerCommandRequest,
} from "../shared/stream-command-transport.js";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  const port = validPort(process.env.COMPANION_PORT);
  const result = port
    ? await runOnServer(`http://localhost:${port}`)
    : mayRunLocally()
      ? await runLocally()
      : failure(
          "No Takode server is configured for this command. Streams are kept by the Takode server: " +
            "run it from a Takode session or set COMPANION_PORT to the server's port.",
        );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

function mayRunLocally(): boolean {
  return !isStreamWriteCommand(args) && !runsOnRemoteHost();
}

/**
 * Reads from this machine's streams when its own server is not running. A
 * machine that keeps none fails instead, before loading the store would create
 * an empty one.
 */
async function runLocally(): Promise<StreamCommandResult> {
  const streamsDir = join(process.env.HOME || homedir(), ".companion", "streams");
  const hasStreams = await stat(streamsDir).then(
    () => true,
    () => false,
  );
  if (!hasStreams) {
    return failure(
      "No Takode server answered, and this machine keeps no streams of its own: " +
        "run the command from a Takode session or set COMPANION_PORT to the server's port.",
    );
  }
  const context = await commandContext();
  const { runStreamCommand } = await import("../server/stream-command.js");
  return runStreamCommand(args, { ...context, readTextFile: readInputFile });
}

async function runOnServer(origin: string): Promise<StreamCommandResult> {
  const files: Record<string, string> = {};
  for (const path of streamCommandInputFiles(args)) {
    try {
      files[path] = await readInputFile(path);
    } catch (error) {
      return failure(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const request: StreamServerCommandRequest = { args, context: await commandContext(), files };
  let response: Response;
  try {
    response = await fetch(`${origin}/api/streams/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(STREAM_SERVER_COMMAND_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    if (mayRunLocally() && !timedOut) return runLocally();
    return failure(
      timedOut
        ? `The Takode server at ${origin} did not answer within ${STREAM_SERVER_COMMAND_TIMEOUT_MS / 1000}s. ` +
            "A change may still have been applied: check with `stream show` before retrying."
        : `Cannot reach the Takode server at ${origin}. Streams are kept by the server: start Takode (or correct COMPANION_PORT) and retry.`,
    );
  }
  const text = await response.text();
  let value: Partial<StreamCommandResult> & { error?: unknown } = {};
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    // Not JSON, e.g. a remote host's proxy reporting an unreachable coordinator, or an older server.
  }
  if (!response.ok) {
    if (response.status === 404 && !value.error) {
      // An older server without the command route: its own machine's streams still answer reads.
      if (mayRunLocally()) return runLocally();
      return failure("The Takode server does not support stream commands yet; restart it on the current build.");
    }
    return failure(
      typeof value.error === "string" ? value.error : text.trim() || `Takode returned HTTP ${response.status}`,
    );
  }
  if (!Number.isInteger(value.exitCode) || typeof value.stdout !== "string" || typeof value.stderr !== "string") {
    return failure("Takode returned an invalid stream command result");
  }
  return { exitCode: value.exitCode!, stdout: value.stdout, stderr: value.stderr };
}

/** The session and default scope, which come from this process and its checkout. */
async function commandContext(): Promise<StreamServerCommandRequest["context"]> {
  const sessionId = process.env.COMPANION_SESSION_ID?.trim();
  const serverId = process.env.COMPANION_SERVER_ID?.trim();
  // Outside a session the default scope is this checkout's Git project, which only this machine can read.
  const projectScope =
    !sessionId && streamCommandNeedsDefaultScope(args) ? await projectStreamScope(process.cwd(), serverId) : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(serverId ? { serverId } : {}),
    ...(projectScope ? { projectScope } : {}),
  };
}

function authHeaders(): Record<string, string> {
  const sessionId = process.env.COMPANION_SESSION_ID?.trim();
  const authToken = process.env.COMPANION_AUTH_TOKEN?.trim();
  if (!sessionId || !authToken) return {};
  return { "x-companion-session-id": sessionId, "x-companion-auth-token": authToken };
}

async function readInputFile(path: string): Promise<string> {
  if (path !== "-") return readFile(path, "utf-8");
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function failure(message: string): StreamCommandResult {
  return { exitCode: 1, stdout: "", stderr: `Error: ${message}\n` };
}

function validPort(raw: string | undefined): number | undefined {
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

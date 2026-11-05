import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserIncomingMessage } from "./session-types.js";
import {
  firstLocalDay,
  TOKEN_USAGE_DAYS_RETAINED,
  tokenUsageLedgerFor,
  type TokenUsageLedgerState,
} from "./workspace-token-usage-ledger.js";
import type {
  SessionTokenUsageLedger,
  TokenUsageBackfillSession,
  TokenUsageDays,
} from "./workspace-token-usage-types.js";
import type { WorkspaceTokenUsageSession } from "./workspace-token-usage.js";

/**
 * Token usage of sessions this coordinator no longer has: archived sessions
 * left on a previous coordinator by a handoff, and deleted sessions.
 *
 * Archived sessions stay in the departing machine's files, and a deleted
 * session's files are removed, yet both still count toward the workspace's
 * all-time and daily usage. Their token usage is kept here, inside the
 * sessions folder; the token usage route adds them to the totals, and later
 * handoffs merge the file forward.
 */
export const TOKEN_USAGE_CARRYOVER_FILE = join("token-usage", "carried-over.json");

/**
 * Days rebuilt from Codex's own logs by the one-time backfill, written only
 * with the user's approval. Removing it undoes the backfill.
 */
export const TOKEN_USAGE_BACKFILL_FILE = join("token-usage", "backfill.json");

/** Entries written before ledgers carry the old token fields and samples; newer ones carry a ledger. */
export interface CarriedOverTokenUsageSession {
  sessionId: string;
  sessionNum?: number;
  state: TokenUsageLedgerState;
}

export interface CarriedOverTokenUsageFile {
  version: 1;
  sessions: CarriedOverTokenUsageSession[];
}

export interface TokenUsageBackfillFile {
  version: 1;
  /** How the days were rebuilt, for whoever reads the file later. */
  source?: string;
  createdAt?: number;
  sessions: TokenUsageBackfillSession[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pruneDays(days: TokenUsageDays | undefined, now: number): TokenUsageDays | undefined {
  if (!days) return undefined;
  const first = firstLocalDay(TOKEN_USAGE_DAYS_RETAINED, now);
  const kept = Object.fromEntries(Object.entries(days).filter(([day]) => day >= first));
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * The token usage of a session's state, reduced to its ledger (derived when the
 * session was recorded before ledgers), or null when it has none.
 */
export function pickCarriedOverTokenUsageState(
  state: unknown,
  now: number,
  messageHistory?: BrowserIncomingMessage[],
): TokenUsageLedgerState | null {
  if (!isRecord(state)) return null;
  const source = state as TokenUsageLedgerState;
  const ledger = tokenUsageLedgerFor(source, messageHistory);
  const days = pruneDays(ledger.days, now) ?? {};
  const convertedDays = pruneDays(ledger.convertedDays, now);
  const kept: SessionTokenUsageLedger = { ...ledger, days };
  if (convertedDays) kept.convertedDays = convertedDays;
  else delete kept.convertedDays;
  const hasUsage = Object.keys(kept.totals).length > 0 || Object.keys(days).length > 0 || convertedDays;
  if (!hasUsage) return null;
  return {
    ...(source.backend_type !== undefined ? { backend_type: source.backend_type } : {}),
    ...(source.model !== undefined ? { model: source.model } : {}),
    token_usage_ledger: kept,
  };
}

export function parseCarriedOverTokenUsage(value: unknown): CarriedOverTokenUsageSession[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) return [];
  return value.sessions.filter(
    (entry): entry is CarriedOverTokenUsageSession =>
      isRecord(entry) && typeof entry.sessionId === "string" && isRecord(entry.state),
  );
}

/** Merge newly retained sessions into those carried over earlier; a newer entry replaces an older one. */
export function mergeCarriedOverTokenUsage(
  previous: CarriedOverTokenUsageSession[],
  added: CarriedOverTokenUsageSession[],
): CarriedOverTokenUsageFile {
  const byId = new Map<string, CarriedOverTokenUsageSession>();
  for (const entry of [...previous, ...added]) byId.set(entry.sessionId, entry);
  return { version: 1, sessions: [...byId.values()] };
}

function isDays(value: unknown): value is TokenUsageDays {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (models) => isRecord(models) && Object.values(models).every((tokens) => typeof tokens === "number"),
    )
  );
}

export function parseTokenUsageBackfill(value: unknown): TokenUsageBackfillSession[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) return [];
  return value.sessions.filter(
    (entry): entry is TokenUsageBackfillSession =>
      isRecord(entry) &&
      typeof entry.sessionId === "string" &&
      typeof entry.cutoff === "number" &&
      Number.isFinite(entry.cutoff) &&
      isDays(entry.days),
  );
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[token-usage] Ignoring unreadable ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function toWorkspaceSession(entry: CarriedOverTokenUsageSession): WorkspaceTokenUsageSession {
  return { sessionId: entry.sessionId, source: { state: entry.state } };
}

/** Read the carried-over sessions in a sessions folder; none when the file is missing or unreadable. */
export async function loadCarriedOverTokenUsage(sessionsDir: string): Promise<WorkspaceTokenUsageSession[]> {
  const value = await readJsonFile(join(sessionsDir, TOKEN_USAGE_CARRYOVER_FILE));
  return parseCarriedOverTokenUsage(value).map(toWorkspaceSession);
}

/**
 * The carried-over and backfill files of one sessions folder, as the server
 * uses them: carried-over sessions are read once and then kept in memory,
 * since only this server adds to them while it runs (a handoff writes the
 * file while the server is stopped); the backfill is reread when the file
 * changes, so an approved backfill shows without a restart.
 */
export class WorkspaceTokenUsageRetainedStore {
  private carried: Promise<CarriedOverTokenUsageSession[]> | undefined;
  private carriedSessions:
    | { entries: CarriedOverTokenUsageSession[]; sessions: WorkspaceTokenUsageSession[] }
    | undefined;
  private pendingWrite: Promise<void> = Promise.resolve();
  private backfill: { mtimeMs: number; sessions: Map<string, TokenUsageBackfillSession> } | undefined;

  constructor(private readonly sessionsDir: string | undefined) {}

  private loadCarried(): Promise<CarriedOverTokenUsageSession[]> {
    const dir = this.sessionsDir;
    this.carried ??= dir
      ? readJsonFile(join(dir, TOKEN_USAGE_CARRYOVER_FILE)).then(parseCarriedOverTokenUsage)
      : Promise.resolve([]);
    return this.carried;
  }

  /** The same objects on every call until a session is retained, so the summary cache can reuse its work. */
  async carriedOverSessions(): Promise<WorkspaceTokenUsageSession[]> {
    const entries = await this.loadCarried();
    if (this.carriedSessions?.entries !== entries) {
      this.carriedSessions = { entries, sessions: entries.map(toWorkspaceSession) };
    }
    return this.carriedSessions.sessions;
  }

  /** Keep a session's token usage before its files are deleted. */
  async retain(entry: CarriedOverTokenUsageSession): Promise<void> {
    const dir = this.sessionsDir;
    if (!dir) return;
    const write = this.pendingWrite.then(async () => {
      const merged = mergeCarriedOverTokenUsage(await this.loadCarried(), [entry]);
      const path = join(dir, TOKEN_USAGE_CARRYOVER_FILE);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(merged));
      await rename(temp, path);
      this.carried = Promise.resolve(merged.sessions);
    });
    this.pendingWrite = write.catch(() => {});
    return write;
  }

  async backfillSessions(): Promise<Map<string, TokenUsageBackfillSession>> {
    const dir = this.sessionsDir;
    if (!dir) return new Map();
    const path = join(dir, TOKEN_USAGE_BACKFILL_FILE);
    const mtimeMs = await stat(path).then(
      (info) => info.mtimeMs,
      () => -1,
    );
    if (this.backfill?.mtimeMs === mtimeMs) return this.backfill.sessions;
    const sessions = new Map<string, TokenUsageBackfillSession>();
    if (mtimeMs >= 0) {
      for (const entry of parseTokenUsageBackfill(await readJsonFile(path))) sessions.set(entry.sessionId, entry);
    }
    this.backfill = { mtimeMs, sessions };
    return sessions;
  }
}

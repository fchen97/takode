import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionTokenUsageSample } from "./session-types.js";
import type { WorkspaceTokenUsageSession, WorkspaceTokenUsageSessionSource } from "./workspace-token-usage.js";

/**
 * Token usage of sessions whose records stayed on a previous coordinator.
 *
 * A coordinator handoff moves only unarchived sessions; archived ones stay in
 * the departing machine's files, yet they hold most of the workspace's
 * all-time usage. The handoff therefore carries just their token fields here,
 * inside the sessions folder, and the token usage route adds them to the
 * totals. Later handoffs merge the file forward.
 */
export const TOKEN_USAGE_CARRYOVER_FILE = join("token-usage", "carried-over.json");

/** Samples older than this cannot reach the longest daily histogram again. */
const CARRYOVER_SAMPLE_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

type TokenUsageState = NonNullable<WorkspaceTokenUsageSessionSource["state"]>;

export interface CarriedOverTokenUsageSession {
  sessionId: string;
  sessionNum?: number;
  state: TokenUsageState;
}

export interface CarriedOverTokenUsageFile {
  version: 1;
  sessions: CarriedOverTokenUsageSession[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep the samples that can still land in a daily bucket, plus, per model, the
 * last one before them: a bucket counts the growth since the previous sample.
 */
export function trimTokenUsageSamplesForCarryover(
  samples: SessionTokenUsageSample[],
  cutoff: number,
): SessionTokenUsageSample[] {
  const lastBefore = new Map<string, SessionTokenUsageSample>();
  for (const sample of samples) {
    if (sample.timestamp >= cutoff) continue;
    const key = `${sample.backend}\u0000${sample.model}`;
    const previous = lastBefore.get(key);
    if (!previous || previous.timestamp <= sample.timestamp) lastBefore.set(key, sample);
  }
  const baselines = new Set(lastBefore.values());
  return samples.filter((sample) => sample.timestamp >= cutoff || baselines.has(sample));
}

/** The token fields of a persisted session state, or null when it has none. */
export function pickCarriedOverTokenUsageState(state: unknown, now: number): TokenUsageState | null {
  if (!isRecord(state)) return null;
  const picked: JsonRecord = {};
  for (const key of [
    "backend_type",
    "model",
    "codex_token_details",
    "claude_token_details",
    "claude_model_usage",
  ] as const) {
    if (state[key] !== undefined) picked[key] = state[key];
  }
  if (Array.isArray(state.token_usage_samples)) {
    const samples = (state.token_usage_samples as unknown[]).filter(
      (sample): sample is SessionTokenUsageSample => isRecord(sample) && typeof sample.timestamp === "number",
    );
    const trimmed = trimTokenUsageSamplesForCarryover(samples, now - CARRYOVER_SAMPLE_WINDOW_MS);
    if (trimmed.length > 0) picked.token_usage_samples = trimmed;
  }
  const hasUsage =
    picked.codex_token_details !== undefined ||
    picked.claude_token_details !== undefined ||
    picked.claude_model_usage !== undefined ||
    picked.token_usage_samples !== undefined;
  return hasUsage ? (picked as TokenUsageState) : null;
}

export function parseCarriedOverTokenUsage(value: unknown): CarriedOverTokenUsageSession[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) return [];
  return value.sessions.filter(
    (entry): entry is CarriedOverTokenUsageSession =>
      isRecord(entry) && typeof entry.sessionId === "string" && isRecord(entry.state),
  );
}

/** Merge sessions left behind by this handoff into those carried over by earlier ones. */
export function mergeCarriedOverTokenUsage(
  previous: CarriedOverTokenUsageSession[],
  leftBehind: CarriedOverTokenUsageSession[],
): CarriedOverTokenUsageFile {
  const byId = new Map<string, CarriedOverTokenUsageSession>();
  for (const entry of [...previous, ...leftBehind]) byId.set(entry.sessionId, entry);
  return { version: 1, sessions: [...byId.values()] };
}

/** Read the carried-over sessions in a sessions folder; none when the file is missing or unreadable. */
export async function loadCarriedOverTokenUsage(sessionsDir: string): Promise<WorkspaceTokenUsageSession[]> {
  let raw: string;
  try {
    raw = await readFile(join(sessionsDir, TOKEN_USAGE_CARRYOVER_FILE), "utf-8");
  } catch {
    return [];
  }
  try {
    return parseCarriedOverTokenUsage(JSON.parse(raw)).map((entry) => ({
      sessionId: entry.sessionId,
      source: { state: entry.state },
    }));
  } catch (error) {
    console.warn(
      `[token-usage] Ignoring unreadable ${TOKEN_USAGE_CARRYOVER_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

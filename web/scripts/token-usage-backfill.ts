/**
 * One-time backfill of daily token usage: Codex sessions' days from Codex's own
 * logs, and archived Claude sessions' days from their history files.
 *
 * Until the per-session token usage ledger, the daily chart was built from each
 * session's last 1,500 cumulative samples, so busy Codex sessions lost the usage
 * of earlier days. Codex itself logs every token update with its time in the
 * thread's rollout files (`<codex home>/<session id>/sessions/**\/rollout-*.jsonl`),
 * so those days can be rebuilt. This script only reads; the server applies the
 * result when it is saved as `<sessions dir>/token-usage/backfill.json`, which
 * only the user's approval allows.
 *
 *   extract  Read rollout files and write each token update as one JSON line.
 *            Needs nothing but this file, so it runs on any machine with rollouts:
 *              bun token-usage-backfill.ts extract --codex-home <dir> --since <iso> > events.jsonl
 *   extract-history
 *            Print the Claude results in the history files of sessions whose
 *            usage is still recorded the old way (archived sessions: the server
 *            loads them without history, so their history-derived days vanish
 *            on restart). Reads only; needs nothing but this file:
 *              bun token-usage-backfill.ts extract-history --sessions-dir <dir> > history.jsonl
 *   plan     Rebuild per-day totals from extracted updates and compare them with
 *            what each session already shows (copies of the session files):
 *              TZ=<server time zone> bun token-usage-backfill.ts plan --sessions-dir <copy> \
 *                --events events.jsonl [--events more.jsonl] [--history history.jsonl] [--out backfill.json]
 */
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { BrowserIncomingMessage } from "../server/session-types.js";

/** One Codex token update: the thread's cumulative total, and the last call's usage. */
export interface CodexTokenEvent {
  sessionId: string;
  /** The rollout's thread; each thread has its own cumulative total. */
  thread: string;
  timestamp: number;
  totalTokens: number;
  lastTokens: number;
  model: string | null;
}

/** Turn one rollout line into a model change or a token update; anything else is null. */
export function parseRolloutLine(
  line: string,
):
  | { kind: "subagent" }
  | { kind: "model"; model: string }
  | { kind: "tokens"; event: Omit<CodexTokenEvent, "sessionId" | "thread" | "model"> }
  | null {
  if (!line.includes('"turn_context"') && !line.includes('"token_count"') && !line.includes('"session_meta"')) {
    return null;
  }
  let entry: { timestamp?: string; type?: string; payload?: Record<string, any> };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  // Subagent threads are not part of what Takode records for the session.
  if (entry.type === "session_meta") {
    const source = entry.payload?.source;
    return entry.payload?.thread_source === "subagent" || (typeof source === "object" && source?.subagent)
      ? { kind: "subagent" }
      : null;
  }
  if (entry.type === "turn_context" && typeof entry.payload?.model === "string") {
    return { kind: "model", model: entry.payload.model };
  }
  const info = entry.payload?.type === "token_count" ? entry.payload.info : null;
  const totalTokens = info?.total_token_usage?.total_tokens;
  const timestamp = Date.parse(entry.timestamp ?? "");
  if (typeof totalTokens !== "number" || !Number.isFinite(timestamp)) return null;
  const lastTokens = info?.last_token_usage?.total_tokens;
  return {
    kind: "tokens",
    event: { timestamp, totalTokens, lastTokens: typeof lastTokens === "number" ? lastTokens : 0 },
  };
}

/**
 * Usage per day and model from one session's token updates, before `cutoff`.
 * Growth is the change in a thread's cumulative total. When the total drops or
 * there is no earlier update in that thread, only the last call's own usage is
 * counted, never the whole cumulative total.
 */
export function rebuildDays(
  events: CodexTokenEvent[],
  options: { cutoff: number; firstDay: string; fallbackModel: string | null; formatDay: (timestamp: number) => string },
): Record<string, Record<string, number>> {
  const threads = new Map<string, CodexTokenEvent[]>();
  const seen = new Set<string>();
  for (const event of events) {
    // The same thread can be logged in more than one Codex home (a copied rollout).
    const key = `${event.thread}:${event.timestamp}:${event.totalTokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const thread = threads.get(event.thread) ?? [];
    thread.push(event);
    threads.set(event.thread, thread);
  }
  const days: Record<string, Record<string, number>> = {};
  for (const thread of threads.values()) {
    thread.sort((left, right) => left.timestamp - right.timestamp);
    let previous: number | null = null;
    for (const event of thread) {
      if (event.totalTokens === previous) continue;
      const growth =
        previous !== null && event.totalTokens > previous
          ? event.totalTokens - previous
          : Math.max(0, event.lastTokens);
      previous = event.totalTokens;
      if (event.timestamp >= options.cutoff) continue;
      const day = options.formatDay(event.timestamp);
      const model = event.model ?? options.fallbackModel;
      if (day < options.firstDay || !model || growth <= 0) continue;
      days[day] ??= {};
      days[day][model] = (days[day][model] ?? 0) + growth;
    }
  }
  return days;
}

async function* rolloutFiles(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(path);
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) yield path;
  }
}

/** Print every token update in rollout files changed since `since`, one JSON line each. */
async function extract(codexHome: string, since: number): Promise<void> {
  for (const sessionId of await readdir(codexHome)) {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) continue;
    for await (const file of rolloutFiles(join(codexHome, sessionId, "sessions"))) {
      if ((await stat(file)).mtimeMs < since) continue;
      const thread = basename(file, ".jsonl").slice(-36);
      let model: string | null = null;
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      for await (const line of lines) {
        const parsed = parseRolloutLine(line);
        if (parsed?.kind === "subagent") break;
        if (parsed?.kind === "model") model = parsed.model;
        else if (parsed?.kind === "tokens") {
          process.stdout.write(`${JSON.stringify({ sessionId, thread, model, ...parsed.event })}\n`);
        }
      }
      lines.close();
    }
  }
}

/** One Claude result from a session's history: its time and cumulative per-model usage. */
export interface ClaudeHistoryResult {
  sessionId: string;
  timestamp: number;
  uuid?: string;
  modelUsage: Record<string, unknown>;
}

/** Claude results anywhere in a parsed history record (history files nest messages in different envelopes). */
export function findClaudeResults(value: unknown, found: Omit<ClaudeHistoryResult, "sessionId">[] = []) {
  if (Array.isArray(value)) {
    for (const item of value) findClaudeResults(item, found);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, any>;
    if (record.type === "result" && typeof record.timestamp === "number" && record.data?.modelUsage) {
      found.push({
        timestamp: record.timestamp,
        ...(typeof record.data.uuid === "string" ? { uuid: record.data.uuid } : {}),
        modelUsage: record.data.modelUsage,
      });
    } else {
      for (const item of Object.values(record)) findClaudeResults(item, found);
    }
  }
  return found;
}

async function extractHistory(sessionsDir: string): Promise<void> {
  const names = await readdir(sessionsDir);
  for (const name of names) {
    const sessionId = /^([0-9a-f-]{36})\.json$/.exec(name)?.[1];
    if (!sessionId) continue;
    const hot = JSON.parse(await readFile(join(sessionsDir, name), "utf-8"));
    if (hot.state?.token_usage_ledger || hot.state?.backend_type === "codex") continue;
    const results = findClaudeResults(hot.messageHistory);
    for (const file of names.filter(
      (other) =>
        other === `${sessionId}.history.jsonl` ||
        (other.startsWith(`${sessionId}.history-`) && other.endsWith(".data")),
    )) {
      const lines = createInterface({ input: createReadStream(join(sessionsDir, file)), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.includes('"result"')) continue;
        try {
          findClaudeResults(JSON.parse(line), results);
        } catch {
          // A torn last line of a journal holds nothing complete.
        }
      }
    }
    const seen = new Set<string>();
    for (const result of results) {
      const key = `${result.timestamp}:${result.uuid ?? JSON.stringify(result.modelUsage)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      process.stdout.write(`${JSON.stringify({ sessionId, ...result })}\n`);
    }
  }
}

async function plan(
  sessionsDir: string,
  eventFiles: string[],
  historyFiles: string[],
  out: string | undefined,
): Promise<void> {
  const { buildWorkspaceTokenUsageByModel } = await import("../server/workspace-token-usage.js");
  const {
    dayTotal,
    deriveLegacyTokenUsageLedger,
    firstLocalDay,
    formatLocalDay,
    normalizeModelLabel,
    tokenUsageLedgerFor,
    TOKEN_USAGE_DAYS_RETAINED,
  } = await import("../server/workspace-token-usage-ledger.js");
  const { loadCarriedOverTokenUsage } = await import("../server/workspace-token-usage-carryover.js");
  const now = Date.now();

  const sessions: import("../server/workspace-token-usage.js").WorkspaceTokenUsageSession[] = [];
  const sessionNums = new Map<string, number>();
  const launcher = JSON.parse(await readFile(join(sessionsDir, "launcher.json"), "utf-8").catch(() => "[]"));
  for (const info of Array.isArray(launcher) ? launcher : Object.values(launcher)) {
    if (typeof info?.sessionId === "string" && Number.isInteger(info.sessionNum)) {
      sessionNums.set(info.sessionId, info.sessionNum);
    }
  }
  for (const name of await readdir(sessionsDir)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const persisted = JSON.parse(await readFile(join(sessionsDir, name), "utf-8"));
    const sessionId = name.slice(0, 36);
    // A copy taken while the server writes can catch a file mid-replacement; skip it rather than misattribute.
    if (persisted.id !== sessionId) {
      console.warn(`skipping ${name}: it holds session ${persisted.id}; copy it again`);
      continue;
    }
    sessions.push({ sessionId, source: { state: persisted.state } });
  }
  const ownIds = new Set(sessions.map((session) => session.sessionId));
  for (const session of await loadCarriedOverTokenUsage(sessionsDir)) {
    if (!ownIds.has(session.sessionId)) sessions.push(session);
  }

  const eventsBySession = new Map<string, CodexTokenEvent[]>();
  for (const file of eventFiles) {
    for (const line of (await readFile(file, "utf-8")).split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as CodexTokenEvent;
      const list = eventsBySession.get(event.sessionId) ?? [];
      list.push(event);
      eventsBySession.set(event.sessionId, list);
    }
  }

  const firstDay = firstLocalDay(TOKEN_USAGE_DAYS_RETAINED, now);
  const backfill: import("../server/workspace-token-usage-types.js").TokenUsageBackfillSession[] = [];
  for (const session of sessions) {
    const state = session.source?.state;
    const events = eventsBySession.get(session.sessionId);
    if (state?.backend_type !== "codex" || !events) continue;
    const ledger = tokenUsageLedgerFor(state);
    const cutoff = ledger.trackingSince ?? now;
    const rebuilt = rebuildDays(
      events.map((event) => ({ ...event, model: normalizeModelLabel(event.model) })),
      { cutoff, firstDay, fallbackModel: normalizeModelLabel(state.model), formatDay: formatLocalDay },
    );
    // Keep only days the logs show more of than the session already does before live recording.
    const days = Object.fromEntries(
      Object.entries(rebuilt).filter(([day, models]) => dayTotal(models) > dayTotal(ledger.convertedDays?.[day])),
    );
    if (Object.keys(days).length === 0) continue;
    const sessionNum = sessionNums.get(session.sessionId);
    backfill.push({ sessionId: session.sessionId, ...(sessionNum !== undefined ? { sessionNum } : {}), cutoff, days });
  }

  // Sessions still recorded the old way get the days their history adds; the
  // server derives their days from samples alone because it loads them without history.
  const historyBySession = new Map<string, BrowserIncomingMessage[]>();
  for (const file of historyFiles) {
    for (const line of (await readFile(file, "utf-8")).split("\n")) {
      if (!line.trim()) continue;
      const result = JSON.parse(line) as ClaudeHistoryResult;
      const list = historyBySession.get(result.sessionId) ?? [];
      list.push({ type: "result", timestamp: result.timestamp, data: { modelUsage: result.modelUsage } } as never);
      historyBySession.set(result.sessionId, list);
    }
  }
  for (const session of sessions) {
    const state = session.source?.state;
    const history = historyBySession.get(session.sessionId);
    if (!history || !state || state.token_usage_ledger || state.backend_type === "codex") continue;
    history.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
    const shown = tokenUsageLedgerFor(state).convertedDays ?? {};
    const recovered = deriveLegacyTokenUsageLedger(state, history).convertedDays ?? {};
    const days = Object.fromEntries(
      Object.entries(recovered).filter(([day, models]) => day >= firstDay && dayTotal(models) > dayTotal(shown[day])),
    );
    if (Object.keys(days).length === 0) continue;
    const sessionNum = sessionNums.get(session.sessionId);
    backfill.push({
      sessionId: session.sessionId,
      ...(sessionNum !== undefined ? { sessionNum } : {}),
      cutoff: now,
      days,
    });
  }

  const bySession = new Map(backfill.map((entry) => [entry.sessionId, entry]));
  const month = (withBackfill: boolean) =>
    buildWorkspaceTokenUsageByModel(
      sessions.map((session) => ({ ...session, backfill: withBackfill ? bySession.get(session.sessionId) : null })),
      now,
    ).history.ranges.find((range) => range.id === "month")!.buckets;
  const before = month(false);
  const after = month(true);
  const millions = (tokens: number) => `${(tokens / 1e6).toFixed(1)}M`.padStart(10);
  console.log(`day         ${"now".padStart(10)} ${"rebuilt".padStart(10)} ${"added".padStart(10)}`);
  for (const [index, bucket] of before.entries()) {
    const rebuiltTotal = after[index].totalTokens;
    console.log(
      `${bucket.date}  ${millions(bucket.totalTokens)} ${millions(rebuiltTotal)} ${millions(rebuiltTotal - bucket.totalTokens)}`,
    );
  }
  console.log(
    `${backfill.length} sessions, ${backfill.reduce((n, entry) => n + Object.keys(entry.days).length, 0)} session-days`,
  );
  if (out) {
    const source = "Codex rollout logs (token_count events) and Claude results in archived sessions' history files";
    const file = { version: 1, source, createdAt: now, sessions: backfill };
    await writeFile(out, `${JSON.stringify(file, null, 1)}\n`);
    console.log(`wrote ${out}`);
  }
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === name) values.push(args[index + 1]);
  return values;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "extract") {
    const [codexHome] = flagValues(args, "--codex-home");
    const [since] = flagValues(args, "--since");
    if (!codexHome || !since) throw new Error("extract needs --codex-home <dir> --since <iso date>");
    await extract(codexHome, Date.parse(since));
  } else if (command === "extract-history") {
    const [sessionsDir] = flagValues(args, "--sessions-dir");
    if (!sessionsDir) throw new Error("extract-history needs --sessions-dir <dir>");
    await extractHistory(sessionsDir);
  } else if (command === "plan") {
    const [sessionsDir] = flagValues(args, "--sessions-dir");
    const events = flagValues(args, "--events");
    const history = flagValues(args, "--history");
    if (!sessionsDir || events.length + history.length === 0) {
      throw new Error("plan needs --sessions-dir <dir> and --events <file> or --history <file>");
    }
    await plan(sessionsDir, events, history, flagValues(args, "--out")[0]);
  } else {
    throw new Error("usage: token-usage-backfill.ts extract|extract-history|plan ... (see the header comment)");
  }
}

import type { QuestmasterTask } from "./quest-types.js";

/**
 * Size limits that keep one quest from stalling the server.
 *
 * Quests are read, listed and serialized on the server's single thread, so a
 * quest note holding a 100 MB evidence ledger made every list and every write
 * to that quest block the server for seconds. The store refuses new text
 * values larger than MAX_QUEST_TEXT_BYTES, and whole-quest lists shorten long
 * text values to a summary. Existing oversized values stay readable.
 */

/** Largest single text value (a note, TLDR, description, debrief...) a quest change may add, in UTF-8 bytes. */
export const MAX_QUEST_TEXT_BYTES = 1024 * 1024;

/** Characters of each long text value a whole-quest list keeps; `quest show` has the full text. */
export const QUEST_LIST_TEXT_CHARS = 500;

export class QuestTextTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestTextTooLargeError";
  }
}

type Path = (string | number)[];

interface OversizedText {
  path: Path;
  value: string;
  bytes: number;
}

/**
 * Refuse a store change that adds a text value over MAX_QUEST_TEXT_BYTES to
 * any quest it changes. A value the quest already held before the change is
 * allowed, so oversized notes written before the limit existed keep loading
 * and the quests holding them can still be edited, claimed or cancelled.
 * Quests the change left untouched (the same object) are not inspected.
 */
export function assertQuestTextWithinLimit(
  before: readonly QuestmasterTask[],
  after: readonly QuestmasterTask[],
  maxBytes = MAX_QUEST_TEXT_BYTES,
): void {
  const kept = new Set(before);
  let beforeById: Map<string, QuestmasterTask> | undefined;
  for (const quest of after) {
    if (kept.has(quest)) continue;
    const added = oversizedText(quest, maxBytes);
    if (added.length === 0) continue;
    beforeById ??= new Map(before.map((previous) => [previous.questId, previous]));
    const previous = beforeById.get(quest.questId);
    const existing = previous ? oversizedText(previous, maxBytes).map((entry) => entry.value) : [];
    const offending = added.find((entry) => !existing.includes(entry.value));
    if (offending) throw new QuestTextTooLargeError(tooLargeMessage(quest.questId, offending, maxBytes));
  }
}

function oversizedText(quest: QuestmasterTask, maxBytes: number): OversizedText[] {
  const found: OversizedText[] = [];
  const visit = (value: unknown, path: Path) => {
    if (typeof value === "string") {
      // A UTF-16 code unit takes at most 3 UTF-8 bytes, and at least 1.
      if (value.length * 3 <= maxBytes) return;
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > maxBytes) found.push({ path, value, bytes });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  visit(quest, []);
  return found;
}

function tooLargeMessage(questId: string, entry: OversizedText, maxBytes: number): string {
  return (
    `${questId} ${describePath(entry.path)} is ${formatMegabytes(entry.bytes)}, over the ` +
    `${formatMegabytes(maxBytes)} limit for quest text. Keep large content such as logs, ledgers ` +
    `or evidence in a file or a Library artifact, and put a short pointer to it in the quest.`
  );
}

/** `["feedback", 3, "text"]` reads as "feedback #3 text". */
function describePath(path: Path): string {
  if (path.length === 0) return "text";
  return path.map((part) => (typeof part === "number" ? `#${part}` : part)).join(" ");
}

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

/** Prose fields that can be long, on the quest itself, each feedback entry and each round. */
const QUEST_PROSE_FIELDS = ["description", "tldr", "notes", "debrief", "debriefTldr"] as const;
const FEEDBACK_PROSE_FIELDS = ["text", "tldr"] as const;
const ROUND_PROSE_FIELDS = ["brief", "outcome", "outcomeTldr"] as const;

/**
 * A quest for a whole-quest list (`quest list`, `quest mine`): every prose
 * field longer than `maxChars` (description, TLDR, debrief, note bodies,
 * round briefs and outcomes) is cut to its start plus a pointer to
 * `quest show`, so lists carry note summaries rather than full note bodies.
 * Returns the quest itself when nothing needed shortening.
 */
export function summarizeQuestForList(quest: QuestmasterTask, maxChars = QUEST_LIST_TEXT_CHARS): QuestmasterTask {
  const record = quest as unknown as Record<string, unknown>;
  const shorten = (value: Record<string, unknown>, fields: readonly string[]) => {
    let copy: Record<string, unknown> | undefined;
    for (const field of fields) {
      const text = value[field];
      if (typeof text !== "string" || text.length <= maxChars) continue;
      copy ??= { ...value };
      copy[field] = shortenQuestListText(text, maxChars, quest.questId);
    }
    return copy ?? value;
  };
  const shortenEach = (items: unknown, fields: readonly string[]) => {
    if (!Array.isArray(items)) return items;
    let copy: unknown[] | undefined;
    items.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const next = shorten(item as Record<string, unknown>, fields);
      if (next === item) return;
      copy ??= [...items];
      copy[index] = next;
    });
    return copy ?? items;
  };

  let result = shorten(record, QUEST_PROSE_FIELDS);
  for (const [field, fields] of [
    ["feedback", FEEDBACK_PROSE_FIELDS],
    ["rounds", ROUND_PROSE_FIELDS],
  ] as const) {
    const next = shortenEach(record[field], fields);
    if (next === record[field]) continue;
    if (result === record) result = { ...record };
    result[field] = next;
  }
  return result as unknown as QuestmasterTask;
}

/** The start of `text` when it is longer than `maxChars`, with a note saying where the rest is. */
export function shortenQuestListText(text: string, maxChars: number, questId: string): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  // Do not split a surrogate pair.
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}… [${text.length - end} more characters; quest show ${questId} has the full text]`;
}

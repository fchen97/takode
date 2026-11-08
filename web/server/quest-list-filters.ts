import { createHash } from "node:crypto";
import type { QuestListPreview, QuestmasterTask } from "./quest-types.js";
import { hasQuestReviewMetadata, isQuestReviewInboxUnread } from "./quest-types.js";
import { prepareSearchQuery, type PreparedSearchQuery, tokenizeSearchText } from "../shared/search-utils.js";
import { questRelationshipSearchText } from "./quest-relationships.js";
import { liveQuestFeedbackEntries } from "../shared/quest-feedback.js";
import { QUEST_LIST_TEXT_CHARS, shortenQuestListText } from "./quest-text-limits.js";
import {
  compactPhaseDocumentationGroups,
  phaseDocumentationPreview,
  summarizeQuestPhaseDocumentation,
} from "../shared/quest-phase-documentation-summary.js";
import {
  getPreviousQuestOwners,
  getQuestDisplayOwner,
  getQuestOwner,
  questOwnerKey,
  type QuestOwnerKind,
  type QuestOwnerRef,
} from "../shared/quest-owner.js";

export interface QuestListFilterOptions {
  status?: string;
  tags?: string;
  tag?: string;
  excludeTags?: string;
  session?: string;
  text?: string;
  verification?: string;
}

export type QuestListSortColumn =
  | "cards"
  | "quest"
  | "title"
  | "owner"
  | "leader"
  | "status"
  | "verify"
  | "feedback"
  | "updated";
export type QuestListSortDirection = "asc" | "desc";

export interface QuestListPageOptions extends QuestListFilterOptions {
  offset?: number;
  limit?: number;
  sortColumn?: QuestListSortColumn;
  sortDirection?: QuestListSortDirection;
}

export interface QuestListPageResult {
  quests: QuestListPreview[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  previousOffset: number | null;
  counts: Record<QuestStatusOrAll, number>;
  allTags: string[];
}

type QuestStatusOrAll = QuestmasterTask["status"] | "all";
type QuestListEntry = { quest: QuestmasterTask; searchDocument?: QuestSearchDocument; matchesText?: boolean };
type QuestSearchDocument = {
  termFrequency: Map<string, number>;
  tokenCount: number;
  recencyTs: number;
};
type QuestSearchContext = {
  getDocument?: (quest: QuestmasterTask) => QuestSearchDocument;
  signal?: AbortSignal;
};
type RankedQuestSearchEntry = {
  quest: QuestmasterTask;
  matchQuality: QuestSearchMatchQuality;
  textScore: number;
  finalScore: number;
};
type QuestSearchMatchQuality = {
  worstQuality: number;
  prefixCount: number;
};

type QuestListFilterResult = {
  beforeStatusFilter: QuestmasterTask[];
  filtered: QuestmasterTask[];
  filteredEntries: QuestListEntry[];
  searchCorpusEntries: QuestListEntry[];
};

type ParsedQuestListFilters = {
  statuses: Set<string>;
  wantsReviewStatusAlias: boolean;
  tagTokens: Set<string>;
  excludedTagTokens: Set<string>;
  verificationScopes: Set<string>;
  sessionId: string;
  ownerKind?: QuestOwnerKind;
  hasTextQuery: boolean;
  preparedSearchQuery: PreparedSearchQuery | null;
};

const STATUS_DISPLAY_ORDER: Record<QuestmasterTask["status"], number> = {
  in_progress: 0,
  refined: 1,
  idea: 2,
  done: 3,
};

const STATUS_SORT_RANK: Record<QuestmasterTask["status"], number> = {
  idea: 0,
  refined: 1,
  in_progress: 2,
  done: 3,
};
const MAX_PAGE_LIMIT = 150;
const TEXT_SEARCH_YIELD_INTERVAL = 25;
const PRIMARY_FIELD_DUPLICATION = 2;
const BODY_FIELD_DUPLICATION = 1;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const QUEST_SEARCH_RECENCY_SHARE = 0.2;

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function applyQuestListFilters(quests: QuestmasterTask[], filters: QuestListFilterOptions): QuestmasterTask[] {
  return filterQuestList(quests, filters).filtered;
}

export function getQuestListPage(quests: QuestmasterTask[], options: QuestListPageOptions): QuestListPageResult {
  const result = filterQuestList(quests, options);
  return buildQuestListPage(
    quests,
    options,
    result.beforeStatusFilter,
    result.filteredEntries,
    result.searchCorpusEntries,
  );
}

/**
 * Share one prepared document per known quest while reading an authoritative corpus
 * for every request. Content fingerprints include derived relationships: neither
 * a quest's own version nor its timestamp proves that its search text is unchanged.
 * The cache retains documents, not quest records or per-query result sets.
 */
export function createQuestListSearch(readQuests: () => Promise<QuestmasterTask[]>) {
  const documents = new Map<string, { fingerprint: string; document: QuestSearchDocument }>();
  let knownQuestIds = new Set<string>();
  let requestSequence = 0;
  let corpusSequence = 0;

  return async (options: QuestListPageOptions, signal?: AbortSignal): Promise<QuestListPageResult> => {
    signal?.throwIfAborted();
    const sequence = ++requestSequence;
    // Do not share an older pending read with a request arriving after a mutation.
    const quests = await readQuests();
    signal?.throwIfAborted();
    if (sequence > corpusSequence) {
      corpusSequence = sequence;
      knownQuestIds = new Set(quests.map((quest) => quest.questId));
      for (const questId of documents.keys()) {
        if (!knownQuestIds.has(questId)) documents.delete(questId);
      }
    }

    return getQuestListPageAsync(quests, options, {
      signal,
      getDocument: (quest) => {
        const fingerprint = questSearchFingerprint(quest);
        const cached = documents.get(quest.questId);
        let document = cached?.fingerprint === fingerprint ? cached.document : buildQuestSearchDocument(quest);
        const recencyTs = questRecencyTs(quest);
        if (document.recencyTs !== recencyTs) document = { ...document, recencyTs };
        // An older in-flight snapshot must not resurrect an entry since deleted.
        if (knownQuestIds.has(quest.questId) && cached?.document !== document) {
          documents.set(quest.questId, { fingerprint, document });
        }
        return document;
      },
    });
  };
}

export async function getQuestListPageAsync(
  quests: QuestmasterTask[],
  options: QuestListPageOptions,
  context: QuestSearchContext = {},
): Promise<QuestListPageResult> {
  context.signal?.throwIfAborted();
  const hasTextQuery = (options.text ?? "").trim().length > 0;
  if (!hasTextQuery) return getQuestListPage(quests, options);
  const result = await filterQuestListAsync(quests, options, context);
  context.signal?.throwIfAborted();
  return buildQuestListPage(
    quests,
    options,
    result.beforeStatusFilter,
    result.filteredEntries,
    result.searchCorpusEntries,
  );
}

function buildQuestListPage(
  quests: QuestmasterTask[],
  options: QuestListPageOptions,
  beforeStatusFilter: QuestmasterTask[],
  filteredEntries: QuestListEntry[],
  searchCorpusEntries: QuestListEntry[],
): QuestListPageResult {
  const sorted = sortQuestList(filteredEntries, options, searchCorpusEntries);
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset, sorted.length);
  const pageQuests = sorted.slice(offset, offset + limit);
  const nextOffset = offset + limit < sorted.length ? offset + limit : null;
  const previousOffset = offset > 0 ? Math.max(0, offset - limit) : null;

  return {
    quests: pageQuests.map((quest) => buildQuestListPreview(quest)),
    total: sorted.length,
    offset,
    limit,
    hasMore: nextOffset !== null,
    nextOffset,
    previousOffset,
    counts: countByStatus(beforeStatusFilter),
    allTags: listAllTags(quests),
  };
}

export function buildQuestListPreview(quest: QuestmasterTask): QuestListPreview {
  const humanFeedback = liveQuestFeedbackEntries(quest.feedback).filter((entry) => entry.author === "human");
  const verificationItems = "verificationItems" in quest ? (quest.verificationItems ?? []) : [];
  const phasePreviewLines = compactPhaseDocumentationGroups(summarizeQuestPhaseDocumentation(quest), 2).flatMap(
    (group) => {
      const latestEntry = group.entries.at(-1);
      if (!latestEntry) return [];
      return [
        {
          key: group.key,
          label: group.displayLabel,
          ...(group.metaLabel ? { metaLabel: group.metaLabel } : {}),
          text: shortenQuestListText(phaseDocumentationPreview(latestEntry), QUEST_LIST_TEXT_CHARS, quest.questId),
        },
      ];
    },
  );

  return {
    preview: true,
    id: quest.id,
    questId: quest.questId,
    version: quest.version,
    title: quest.title,
    status: quest.status,
    ...(quest.tldr ? { tldr: quest.tldr } : {}),
    createdAt: quest.createdAt,
    ...(quest.updatedAt ? { updatedAt: quest.updatedAt } : {}),
    ...(quest.statusChangedAt ? { statusChangedAt: quest.statusChangedAt } : {}),
    ...(quest.tags ? { tags: quest.tags } : {}),
    ...(quest.parentId ? { parentId: quest.parentId } : {}),
    ...(quest.sessionSpaceSlug ? { sessionSpaceSlug: quest.sessionSpaceSlug } : {}),
    ...("sessionId" in quest && quest.sessionId ? { sessionId: quest.sessionId } : {}),
    ...("ownerKind" in quest && quest.ownerKind ? { ownerKind: quest.ownerKind } : {}),
    ...("claimedAt" in quest && quest.claimedAt ? { claimedAt: quest.claimedAt } : {}),
    ...(quest.previousOwnerSessionIds ? { previousOwnerSessionIds: quest.previousOwnerSessionIds } : {}),
    ...(quest.previousOwners ? { previousOwners: quest.previousOwners } : {}),
    ...(quest.leaderSessionId ? { leaderSessionId: quest.leaderSessionId } : {}),
    ...("completedAt" in quest && quest.completedAt ? { completedAt: quest.completedAt } : {}),
    ...("verificationInboxUnread" in quest && typeof quest.verificationInboxUnread === "boolean"
      ? { verificationInboxUnread: quest.verificationInboxUnread }
      : {}),
    ...("cancelled" in quest && quest.cancelled === true ? { cancelled: true } : {}),
    ...("debriefTldr" in quest && quest.debriefTldr ? { debriefTldr: quest.debriefTldr } : {}),
    ...(quest.relationships ? { relationships: quest.relationships } : {}),
    ...(quest.relatedQuests ? { relatedQuests: quest.relatedQuests } : {}),
    ...(quest.journeyRuns ? { journeyRuns: quest.journeyRuns } : {}),
    ...(verificationItems.length > 0
      ? {
          verificationProgress: {
            checked: verificationItems.filter((item) => item.checked).length,
            total: verificationItems.length,
          },
        }
      : {}),
    ...(humanFeedback.length > 0
      ? {
          feedbackSummary: {
            humanTotal: humanFeedback.length,
            humanUnaddressed: humanFeedback.filter((entry) => !entry.addressed).length,
            humanAddressed: humanFeedback.filter((entry) => entry.addressed).length,
          },
        }
      : {}),
    ...(phasePreviewLines.length > 0 ? { phasePreviewLines } : {}),
  };
}

function filterQuestList(quests: QuestmasterTask[], filters: QuestListFilterOptions): QuestListFilterResult {
  const parsed = parseQuestListFilters(filters);
  if (parsed.hasTextQuery && !parsed.preparedSearchQuery) return finishQuestListFilter(parsed, []);

  const beforeStatusEntries: QuestListEntry[] = [];
  for (const quest of quests) {
    const entry = buildQuestListEntry(quest, parsed);
    if (entry) beforeStatusEntries.push(entry);
  }

  return finishQuestListFilter(parsed, beforeStatusEntries);
}

async function filterQuestListAsync(
  quests: QuestmasterTask[],
  filters: QuestListFilterOptions,
  context: QuestSearchContext,
): Promise<QuestListFilterResult> {
  const parsed = parseQuestListFilters(filters);
  if (parsed.hasTextQuery && !parsed.preparedSearchQuery) return finishQuestListFilter(parsed, []);

  const beforeStatusEntries: QuestListEntry[] = [];
  for (const [index, quest] of quests.entries()) {
    if (index > 0 && index % TEXT_SEARCH_YIELD_INTERVAL === 0) await yieldToEventLoop();
    context.signal?.throwIfAborted();
    const entry = buildQuestListEntry(quest, parsed, context.getDocument);
    if (entry) beforeStatusEntries.push(entry);
  }

  return finishQuestListFilter(parsed, beforeStatusEntries);
}

function parseQuestListFilters(filters: QuestListFilterOptions): ParsedQuestListFilters {
  const requestedStatuses = parseCsv(filters.status);
  const statuses = new Set(requestedStatuses.filter((status) => status !== "needs_verification"));
  const wantsReviewStatusAlias = requestedStatuses.includes("needs_verification");
  const tagTokens = new Set([...parseCsv(filters.tags), ...parseCsv(filters.tag)].map((tag) => tag.toLowerCase()));
  const excludedTagTokens = new Set(parseCsv(filters.excludeTags).map((tag) => tag.toLowerCase()));
  const verificationScopes = new Set(parseCsv(filters.verification).map((scope) => scope.toLowerCase()));
  const ownerFilter = parseOwnerFilter(filters.session);
  const textQuery = (filters.text ?? "").trim();
  const hasTextQuery = textQuery.length > 0;
  const preparedSearchQuery = hasTextQuery ? prepareSearchQuery(textQuery) : null;

  return {
    statuses,
    wantsReviewStatusAlias,
    tagTokens,
    excludedTagTokens,
    verificationScopes,
    sessionId: ownerFilter.sessionId,
    ...(ownerFilter.ownerKind ? { ownerKind: ownerFilter.ownerKind } : {}),
    hasTextQuery,
    preparedSearchQuery,
  };
}

function buildQuestListEntry(
  quest: QuestmasterTask,
  filters: ParsedQuestListFilters,
  getDocument: (quest: QuestmasterTask) => QuestSearchDocument = buildQuestSearchDocument,
): QuestListEntry | null {
  if (!matchesVerificationFilter(quest, filters.verificationScopes)) return null;
  if (!matchesTagFilters(quest, filters.tagTokens, filters.excludedTagTokens)) return null;
  if (!matchesSessionFilter(quest, filters.sessionId, filters.ownerKind)) return null;

  if (!filters.hasTextQuery) return { quest };
  if (!filters.preparedSearchQuery) return null;
  const searchDocument = getDocument(quest);
  return { quest, searchDocument, matchesText: matchesAllQueryTokens(searchDocument, filters.preparedSearchQuery) };
}

function finishQuestListFilter(
  filters: ParsedQuestListFilters,
  beforeStatusEntries: QuestListEntry[],
): QuestListFilterResult {
  const textFilteredEntries = filters.hasTextQuery
    ? beforeStatusEntries.filter((entry) => entry.matchesText === true)
    : beforeStatusEntries;
  const matchesStatus = (entry: QuestListEntry) =>
    filters.statuses.has(entry.quest.status) || (filters.wantsReviewStatusAlias && hasQuestReviewMetadata(entry.quest));
  const filteredEntries =
    filters.statuses.size > 0 || filters.wantsReviewStatusAlias
      ? textFilteredEntries.filter(matchesStatus)
      : textFilteredEntries;
  const searchCorpusEntries =
    filters.hasTextQuery && (filters.statuses.size > 0 || filters.wantsReviewStatusAlias)
      ? beforeStatusEntries.filter(matchesStatus)
      : beforeStatusEntries;
  return {
    beforeStatusFilter: textFilteredEntries.map((entry) => entry.quest),
    filtered: filteredEntries.map((entry) => entry.quest),
    filteredEntries,
    searchCorpusEntries,
  };
}

function matchesVerificationFilter(quest: QuestmasterTask, verificationScopes: Set<string>): boolean {
  if (verificationScopes.size === 0) return true;
  const isReview = hasQuestReviewMetadata(quest);
  const inInbox = isQuestReviewInboxUnread(quest);
  const wantsAnyVerification =
    verificationScopes.has("all") ||
    verificationScopes.has("verification") ||
    verificationScopes.has("needs_verification");
  const wantsInbox =
    verificationScopes.has("inbox") || verificationScopes.has("unread") || verificationScopes.has("new");
  const wantsReviewed =
    verificationScopes.has("reviewed") ||
    verificationScopes.has("non-inbox") ||
    verificationScopes.has("non_inbox") ||
    verificationScopes.has("read") ||
    verificationScopes.has("acknowledged");

  if (wantsAnyVerification && isReview) return true;
  if (wantsInbox && inInbox) return true;
  return wantsReviewed && isReview && !inInbox;
}

function matchesTagFilters(quest: QuestmasterTask, tagTokens: Set<string>, excludedTagTokens: Set<string>): boolean {
  if (tagTokens.size === 0 && excludedTagTokens.size === 0) return true;
  const questTags = new Set((quest.tags || []).map((tag) => tag.toLowerCase()));

  if (tagTokens.size > 0) {
    let hasAnyTag = false;
    for (const tag of tagTokens) {
      if (!questTags.has(tag)) continue;
      hasAnyTag = true;
      break;
    }
    if (!hasAnyTag) return false;
  }

  for (const tag of excludedTagTokens) {
    if (questTags.has(tag)) return false;
  }
  return true;
}

function matchesSessionFilter(quest: QuestmasterTask, sessionId: string, ownerKind?: QuestOwnerKind): boolean {
  if (!sessionId) return ownerKind === undefined;
  return questOwnerRefs(quest).some(
    (owner) => owner.sessionId === sessionId && (ownerKind === undefined || owner.kind === ownerKind),
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sortQuestList(
  entries: QuestListEntry[],
  options: QuestListPageOptions,
  searchCorpusEntries: QuestListEntry[],
): QuestmasterTask[] {
  const textQuery = (options.text ?? "").trim();
  if (textQuery) {
    const query = prepareSearchQuery(textQuery);
    if (!query) return [];
    return rankQuestSearchEntries(entries, searchCorpusEntries, query).map((entry) => entry.quest);
  }

  const column = options.sortColumn ?? "cards";
  const direction = options.sortDirection ?? (column === "cards" ? "asc" : "desc");
  return entries
    .map((entry) => entry.quest)
    .sort((left, right) => {
      const columnResult = compareSortColumn(left, right, column);
      const directed = direction === "asc" ? columnResult : -columnResult;
      if (directed !== 0) return directed;
      return questRecencyTs(right) - questRecencyTs(left) || compareQuestIds(left, right);
    });
}

function compareSortColumn(left: QuestmasterTask, right: QuestmasterTask, column: QuestListSortColumn): number {
  switch (column) {
    case "cards": {
      const statusResult = STATUS_DISPLAY_ORDER[left.status] - STATUS_DISPLAY_ORDER[right.status];
      if (statusResult !== 0) return statusResult;
      return questRecencyTs(right) - questRecencyTs(left);
    }
    case "quest":
      return compareQuestIds(left, right);
    case "title":
      return compareText(left.title, right.title);
    case "owner":
      return compareText(getQuestOwnerSortKey(left), getQuestOwnerSortKey(right));
    case "leader":
      return compareText(left.leaderSessionId ?? "", right.leaderSessionId ?? "");
    case "status":
      return STATUS_SORT_RANK[left.status] - STATUS_SORT_RANK[right.status];
    case "verify":
      return compareNumberTuple(verificationSortTuple(left), verificationSortTuple(right));
    case "feedback":
      return compareNumberTuple(feedbackSortTuple(left), feedbackSortTuple(right));
    case "updated":
      return questRecencyTs(left) - questRecencyTs(right);
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalizeOffset(offset: number | undefined, total: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const normalized = Math.max(0, Math.trunc(offset));
  return Math.min(normalized, Math.max(0, total));
}

function countByStatus(quests: QuestmasterTask[]): Record<QuestStatusOrAll, number> {
  const counts: Record<QuestStatusOrAll, number> = { all: quests.length, idea: 0, refined: 0, in_progress: 0, done: 0 };
  for (const quest of quests) counts[quest.status] += 1;
  return counts;
}

function listAllTags(quests: QuestmasterTask[]): string[] {
  const tags = new Set<string>();
  for (const quest of quests) {
    for (const tag of quest.tags ?? []) tags.add(tag.toLowerCase());
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function rankQuestSearchEntries(
  entries: QuestListEntry[],
  searchCorpusEntries: QuestListEntry[],
  query: PreparedSearchQuery,
): RankedQuestSearchEntry[] {
  const searchEntries = entries.filter(
    (entry): entry is { quest: QuestmasterTask; searchDocument: QuestSearchDocument } =>
      entry.searchDocument !== undefined,
  );
  if (searchEntries.length === 0) return [];

  const corpusEntries = searchCorpusEntries.filter(
    (entry): entry is { quest: QuestmasterTask; searchDocument: QuestSearchDocument } =>
      entry.searchDocument !== undefined,
  );
  const scoringCorpus = corpusEntries.length > 0 ? corpusEntries : searchEntries;
  const documentCount = scoringCorpus.length;
  const averageDocumentLength =
    scoringCorpus.reduce((sum, entry) => sum + entry.searchDocument.tokenCount, 0) / documentCount || 1;
  const queryStats = query.map((word) => ({
    word,
    idf: bm25InverseDocumentFrequency(
      documentCount,
      scoringCorpus.filter((entry) => matchingTermFrequency(entry.searchDocument, word) > 0).length,
    ),
  }));

  const textRanked = searchEntries.map((entry) => ({
    quest: entry.quest,
    searchDocument: entry.searchDocument,
    matchQuality: questSearchMatchQuality(entry.searchDocument, query),
    textScore: bm25DocumentScore(entry.searchDocument, queryStats, averageDocumentLength),
  }));
  const maxTextScore = Math.max(...textRanked.map((entry) => entry.textScore), 0);
  const now = Date.now();
  const recencies = textRanked.map((entry) => normalizedRecencyTs(entry.searchDocument, now));
  const minRecency = Math.min(...recencies);
  const maxRecency = Math.max(...recencies);

  return textRanked
    .map((entry) => {
      const freshness = freshnessScore(normalizedRecencyTs(entry.searchDocument, now), minRecency, maxRecency);
      return {
        quest: entry.quest,
        matchQuality: entry.matchQuality,
        textScore: entry.textScore,
        finalScore: entry.textScore + QUEST_SEARCH_RECENCY_SHARE * maxTextScore * freshness,
      };
    })
    .sort(compareRankedQuestSearchEntries);
}

function buildQuestSearchDocument(quest: QuestmasterTask): QuestSearchDocument {
  const termFrequency = new Map<string, number>();
  let tokenCount = 0;
  // Weight frequencies directly instead of duplicating and concatenating all tokens.
  for (const [fields, weight] of [
    [getQuestPrimarySearchFields(quest), PRIMARY_FIELD_DUPLICATION],
    [getQuestBodySearchFields(quest), BODY_FIELD_DUPLICATION],
  ] as const) {
    for (const field of fields) {
      if (!field) continue;
      const tokens = tokenizeSearchText(field);
      tokenCount += tokens.length * weight;
      for (const token of tokens) {
        termFrequency.set(token.value, (termFrequency.get(token.value) ?? 0) + weight);
      }
    }
  }
  return {
    termFrequency,
    tokenCount: Math.max(1, tokenCount),
    recencyTs: questRecencyTs(quest),
  };
}

function questSearchFingerprint(quest: QuestmasterTask): string {
  const hash = createHash("sha256");
  for (const field of [...getQuestPrimarySearchFields(quest), ...getQuestBodySearchFields(quest)]) {
    const text = field ?? "";
    hash.update(`${text.length}:`).update(text);
  }
  return hash.digest("base64url");
}

function getQuestPrimarySearchFields(quest: QuestmasterTask): Array<string | undefined> {
  return [quest.questId, quest.title, (quest.tags ?? []).join(" ")];
}

function getQuestBodySearchFields(quest: QuestmasterTask): Array<string | undefined> {
  return [
    quest.tldr,
    "description" in quest ? quest.description : undefined,
    questRelationshipSearchText(quest),
    quest.status === "done" && quest.cancelled !== true ? quest.debriefTldr : undefined,
    quest.status === "done" && quest.cancelled !== true ? quest.debrief : undefined,
    ...questOwnerRefs(quest).flatMap((owner) => [`${owner.kind} ${owner.sessionId}`, questOwnerKey(owner)]),
    ...(quest.quizItems ?? []).flatMap((item) => [item.question, item.answer, item.source]),
    ...(quest.rounds ?? []).flatMap((round) => [round.title, round.brief, round.outcome]),
    ...("feedback" in quest
      ? liveQuestFeedbackEntries(quest.feedback).flatMap((entry) => [entry.tldr, entry.text])
      : []),
  ];
}

function matchesAllQueryTokens(document: QuestSearchDocument, query: PreparedSearchQuery): boolean {
  return query.every((word) => matchingTermFrequency(document, word) > 0);
}

function bm25InverseDocumentFrequency(documentCount: number, documentFrequency: number): number {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function bm25DocumentScore(
  document: QuestSearchDocument,
  queryStats: Array<{ word: string; idf: number }>,
  averageDocumentLength: number,
): number {
  return queryStats.reduce((score, query) => {
    const frequency = matchingTermFrequency(document, query.word);
    if (frequency <= 0) return score;
    const lengthRatio = document.tokenCount / averageDocumentLength;
    const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio);
    return score + query.idf * ((frequency * (BM25_K1 + 1)) / denominator);
  }, 0);
}

function matchingTermFrequency(document: QuestSearchDocument, word: string): number {
  const exactFrequency = document.termFrequency.get(word);
  if (exactFrequency !== undefined) return exactFrequency;

  let bestPrefixFrequency = 0;
  for (const [term, frequency] of document.termFrequency) {
    if (term.startsWith(word)) bestPrefixFrequency = Math.max(bestPrefixFrequency, frequency);
  }
  return bestPrefixFrequency;
}

function questSearchMatchQuality(document: QuestSearchDocument, query: PreparedSearchQuery): QuestSearchMatchQuality {
  const qualities = query.map((word) => (document.termFrequency.has(word) ? 0 : 1));
  return {
    worstQuality: Math.max(...qualities),
    prefixCount: qualities.filter((quality) => quality > 0).length,
  };
}

function normalizedRecencyTs(document: QuestSearchDocument, now: number): number {
  return Math.min(document.recencyTs, now);
}

function freshnessScore(recencyTs: number, minRecency: number, maxRecency: number): number {
  const range = maxRecency - minRecency;
  if (range <= 0) return 0;
  return (recencyTs - minRecency) / range;
}

function compareRankedQuestSearchEntries(left: RankedQuestSearchEntry, right: RankedQuestSearchEntry): number {
  return (
    left.matchQuality.worstQuality - right.matchQuality.worstQuality ||
    left.matchQuality.prefixCount - right.matchQuality.prefixCount ||
    right.finalScore - left.finalScore ||
    right.textScore - left.textScore ||
    questRecencyTs(right.quest) - questRecencyTs(left.quest) ||
    compareQuestIds(left.quest, right.quest)
  );
}

function compareQuestIds(left: QuestmasterTask, right: QuestmasterTask): number {
  return left.questId.localeCompare(right.questId, undefined, { numeric: true, sensitivity: "base" });
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function questRecencyTs(quest: QuestmasterTask): number {
  return Math.max(quest.createdAt, quest.updatedAt ?? 0, quest.statusChangedAt ?? 0);
}

function getQuestOwnerSortKey(quest: QuestmasterTask): string {
  const owner = getQuestDisplayOwner(quest);
  return owner ? questOwnerKey(owner) : "";
}

function parseOwnerFilter(value: string | undefined): { sessionId: string; ownerKind?: QuestOwnerKind } {
  const normalized = value?.trim() ?? "";
  const qualified = /^(takode|codex):(.*)$/i.exec(normalized);
  if (!qualified) return { sessionId: normalized };
  return {
    ownerKind: qualified[1]!.toLowerCase() as QuestOwnerKind,
    sessionId: qualified[2]!.trim(),
  };
}

function questOwnerRefs(quest: QuestmasterTask): QuestOwnerRef[] {
  const activeOwner = getQuestOwner(quest);
  const previousOwners = getPreviousQuestOwners(quest);
  return activeOwner ? [activeOwner, ...previousOwners] : previousOwners;
}

function verificationSortTuple(quest: QuestmasterTask): [number, number, number] {
  if (!("verificationItems" in quest) || quest.verificationItems.length === 0) return [0, 0, 0];
  const total = quest.verificationItems.length;
  const checked = quest.verificationItems.filter((item) => item.checked).length;
  return [1, checked, total];
}

function feedbackSortTuple(quest: QuestmasterTask): [number, number] {
  const feedback =
    "feedback" in quest ? liveQuestFeedbackEntries(quest.feedback).filter((entry) => entry.author === "human") : [];
  const open = feedback.filter((entry) => !entry.addressed).length;
  return [open, feedback.length];
}

function compareNumberTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

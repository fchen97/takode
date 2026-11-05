/**
 * Board rows a leader session restores from disk can belong to quests that finished or were
 * deleted while the server was down. This drops those rows and keeps every other row.
 */
export async function reconcileRestoredBoardRows(
  session: { board: Map<string, unknown>; boardStallStates: Map<string, unknown> },
  resolveQuestStatus: ((questId: string) => Promise<string | null>) | null,
): Promise<void> {
  if (!resolveQuestStatus || session.board.size === 0) return;
  for (const [questId] of [...session.board]) {
    try {
      const status = await resolveQuestStatus(questId);
      // q-112: the board lifecycle is decoupled from most quest statuses.
      // Restore should only drop rows that are definitely terminal/missing,
      // not queued ideas or verification-stage items that are still active on
      // the leader's board.
      if (status === "done" || status === null) {
        session.board.delete(questId);
        session.boardStallStates.delete(questId);
      }
    } catch {
      // If quest status cannot be resolved, preserve the row and let normal runtime paths decide.
    }
  }
}

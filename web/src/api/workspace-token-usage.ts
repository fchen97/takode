import type { WorkspaceTokenUsageByModelSummary } from "./workspace-token-usage-types.js";

type GetWorkspaceTokenUsage = (path: string, signal?: AbortSignal) => Promise<WorkspaceTokenUsageByModelSummary>;

export function createWorkspaceTokenUsageApi(get: GetWorkspaceTokenUsage) {
  return {
    getWorkspaceTokenUsageByModel: (signal?: AbortSignal) => get("/sessions/token-usage-by-model", signal),
  };
}

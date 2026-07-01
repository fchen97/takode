import type { CodexSpawnSpec } from "./cli-launcher-codex.js";
import type { SdkSessionInfo } from "./session-info.js";

export function buildCodexSpawnLaunchInfo(info: SdkSessionInfo) {
  return {
    cwd: info.cwd,
    cliSessionId: info.cliSessionId,
    isOrchestrator: info.isOrchestrator,
    codexLeaderCompactionMode: info.codexLeaderCompactionMode,
    codexLeaderRecycleThresholdTokens: info.codexLeaderRecycleThresholdTokens,
    codexLeaderRecycleLineage: info.codexLeaderRecycleLineage,
    codexLeaderRecycleThresholdModel: info.codexLeaderRecycleThresholdModel,
    codexLeaderSourceEffectiveContextWindowTokens: info.codexLeaderSourceEffectiveContextWindowTokens,
  };
}

export function applyCodexSpawnMetadata(info: SdkSessionInfo, spawnSpec: CodexSpawnSpec): void {
  info.codexContextWindowDiagnostics = spawnSpec.contextWindowDiagnostics;
  if (typeof spawnSpec.codexLeaderRecycleThresholdTokens !== "number") {
    delete info.codexLeaderRecycleThresholdTokens;
    delete info.codexLeaderRecycleThresholdModel;
    delete info.codexLeaderSourceEffectiveContextWindowTokens;
    return;
  }

  info.codexLeaderRecycleThresholdTokens = spawnSpec.codexLeaderRecycleThresholdTokens;
  info.codexLeaderRecycleThresholdModel = spawnSpec.codexLeaderRecycleThresholdModel;
  info.codexLeaderSourceEffectiveContextWindowTokens = spawnSpec.codexLeaderSourceEffectiveContextWindowTokens;
}

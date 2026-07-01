interface SessionProjectMeta {
  cwd: string;
  repoRoot?: string;
}

interface BridgeSessionProjectMeta {
  state?: {
    repo_root?: string;
    cwd?: string;
  };
}

type GetRepoInfo = (cwd: string) => Promise<{ repoRoot?: string } | null>;

export function createSessionProjectMetaBackfill(getRepoInfo: GetRepoInfo) {
  return async (info: SessionProjectMeta, bridgeSession?: BridgeSessionProjectMeta | null): Promise<void> => {
    if ((!info.cwd || !info.cwd.trim()) && bridgeSession?.state?.cwd) {
      info.cwd = bridgeSession.state.cwd;
    }
    if (info.repoRoot?.trim()) return;
    const fromBridge = bridgeSession?.state?.repo_root?.trim();
    if (fromBridge) {
      info.repoRoot = fromBridge;
      return;
    }
    if (!info.cwd?.trim()) return;
    const inferred = await getRepoInfo(info.cwd);
    if (inferred?.repoRoot) info.repoRoot = inferred.repoRoot;
  };
}

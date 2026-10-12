import { useEffect } from "react";
import { useStore } from "../../store.js";
import { CodexRateLimitsSection, CodexTokenDetailsSection, WorkspaceTokenUsageByModelView } from "../TaskPanel.js";

// ─── Codex Session Demo (injects mock Codex data into a temp session) ────────

export const CODEX_DEMO_SESSION = "codex-playground-demo";

export function CodexPlaygroundDemo() {
  useEffect(() => {
    const store = useStore.getState();
    const prev = store.sessions.get(CODEX_DEMO_SESSION);

    // Create a fake Codex session with rate limits and token details
    store.addSession({
      session_id: CODEX_DEMO_SESSION,
      backend_type: "codex",
      model: "o3",
      cwd: "/Users/demo/project",
      tools: [],
      permissionMode: "bypassPermissions",
      claude_code_version: "0.1.0",
      mcp_servers: [],
      agents: [],
      slash_commands: [],
      skills: [],
      total_cost_usd: 0,
      num_turns: 8,
      context_used_percent: 45,
      is_compacting: false,
      git_branch: "main",
      is_worktree: false,
      is_containerized: false,
      repo_root: "/Users/demo/project",
      git_ahead: 0,
      git_behind: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
      codex_rate_limits: {
        primary: { usedPercent: 62, windowDurationMins: 300, resetsAt: Date.now() + 2 * 3_600_000 },
        secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: Date.now() + 5 * 86_400_000 },
      },
      codex_token_details: {
        inputTokens: 84_230,
        outputTokens: 12_450,
        cachedInputTokens: 41_200,
        reasoningOutputTokens: 8_900,
        modelContextWindow: 200_000,
      },
    });

    return () => {
      useStore.setState((s) => {
        const sessions = new Map(s.sessions);
        if (prev) sessions.set(CODEX_DEMO_SESSION, prev);
        else sessions.delete(CODEX_DEMO_SESSION);
        return { sessions };
      });
    };
  }, []);

  return (
    <div className="w-[280px] border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <CodexRateLimitsSection sessionId={CODEX_DEMO_SESSION} />
      <CodexTokenDetailsSection sessionId={CODEX_DEMO_SESSION} />
      <WorkspaceTokenUsageByModelView
        summary={{
          totalTokens: 4_184_100,
          generatedAt: Date.now(),
          history: {
            ranges: [
              {
                id: "week",
                label: "Past week",
                days: 7,
                granularity: "day",
                totalTokens: 932_000,
                buckets: [
                  {
                    date: "2026-01-02",
                    totalTokens: 90_000,
                    models: [{ model: "gpt-5.3-codex", totalTokens: 90_000 }],
                  },
                  {
                    date: "2026-01-03",
                    totalTokens: 210_000,
                    models: [
                      { model: "claude-sonnet-4-5-20250929", totalTokens: 150_000 },
                      { model: "gpt-5.3-codex", totalTokens: 60_000 },
                    ],
                  },
                  {
                    date: "2026-01-04",
                    totalTokens: 132_000,
                    models: [{ model: "claude-sonnet-4-5-20250929", totalTokens: 132_000 }],
                  },
                  {
                    date: "2026-01-05",
                    totalTokens: 284_000,
                    models: [
                      { model: "claude-sonnet-4-5-20250929", totalTokens: 194_000 },
                      { model: "gpt-5.3-codex", totalTokens: 90_000 },
                    ],
                  },
                  { date: "2026-01-06", totalTokens: 0, models: [] },
                  {
                    date: "2026-01-07",
                    totalTokens: 216_000,
                    models: [
                      { model: "claude-sonnet-4-5-20250929", totalTokens: 101_000 },
                      { model: "gpt-5.3-codex", totalTokens: 115_000 },
                    ],
                  },
                  { date: "2026-01-08", totalTokens: 0, models: [] },
                ],
              },
              {
                id: "month",
                label: "Past month",
                days: 30,
                granularity: "day",
                totalTokens: 2_641_000,
                buckets: [
                  {
                    date: "2026-01-01",
                    totalTokens: 640_000,
                    models: [
                      { model: "claude-sonnet-4-5-20250929", totalTokens: 420_000 },
                      { model: "gpt-5.3-codex", totalTokens: 220_000 },
                    ],
                  },
                  {
                    date: "2026-01-05",
                    totalTokens: 801_000,
                    models: [
                      { model: "claude-sonnet-4-5-20250929", totalTokens: 520_000 },
                      { model: "gpt-5.3-codex", totalTokens: 281_000 },
                    ],
                  },
                  {
                    date: "2026-01-08",
                    totalTokens: 1_200_000,
                    models: [
                      { model: "claude-sonnet-4-5-20250929", totalTokens: 760_000 },
                      { model: "gpt-5.3-codex", totalTokens: 440_000 },
                    ],
                  },
                ],
              },
            ],
            limited: false,
            limitedReasons: [],
          },
          models: [
            {
              model: "claude-sonnet-4-5-20250929",
              totalTokens: 2_650_400,
              inputTokens: 1_010_000,
              outputTokens: 240_400,
              cachedInputTokens: 1_400_000,
              reasoningOutputTokens: 0,
              sessionCount: 7,
            },
            {
              model: "gpt-5.3-codex",
              totalTokens: 1_533_700,
              inputTokens: 470_000,
              outputTokens: 183_700,
              cachedInputTokens: 780_000,
              reasoningOutputTokens: 100_000,
              sessionCount: 3,
              codexModelAttributionLimited: true,
            },
          ],
        }}
      />
    </div>
  );
}

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _ensureCodexSessionConfigForTest } from "./cli-launcher-codex.js";

// Real catalog entries carry Codex's built-in prompt; entries without one are
// treated as stubs older Takode versions wrote.
const PROMPT = "Built-in prompt";

describe("Codex session catalog hardening", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  async function makeCodexHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "takode-codex-catalog-"));
    tempRoots.push(root);
    return root;
  }

  function expectParserSafeEntry(entry: Record<string, unknown>, slug: string): void {
    expect(entry).toMatchObject({
      slug,
      display_name: expect.any(String),
      supported_reasoning_levels: expect.any(Array),
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: expect.any(Number),
      base_instructions: expect.any(String),
      supports_reasoning_summaries: expect.any(Boolean),
      support_verbosity: expect.any(Boolean),
      truncation_policy: {
        mode: expect.any(String),
        limit: expect.any(Number),
      },
      supports_parallel_tool_calls: expect.any(Boolean),
      experimental_supported_tools: expect.any(Array),
    });
  }

  // Codex runs a model no catalog knows with its own generic prompt and tools.
  // Takode used to add a prompt-less entry, which made Codex send no prompt;
  // now it adds none and keeps the leader guard in the top-level config.
  it("adds no catalog entry for a leader model no catalog knows, keeping the context guard in config", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const model = "takode-test-leader";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderRecycleThresholdTokens: 260_000,
      model,
      loadBundledModelCatalog: async () => ({ models: [] }),
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).not.toContain("model_catalog_json");
    expect(config).toContain("model_context_window = 1444445");
    expect(config).toContain("model_auto_compact_token_limit = 1300000");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(model));
    warn.mockRestore();
  });

  it("registers a Takode-owned delegate MCP server in leader session config", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, 'model = "takode-test-leader"\n', "utf-8");
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: true,
      model: "takode-test-leader",
      takodeDelegateMcp: {
        enabled: true,
        command: process.execPath,
        args: ["/repo/web/bin/takode-delegate-mcp.ts"],
        env: {
          COMPANION_AUTH_TOKEN: "secret-token",
          COMPANION_PORT: "3456",
          COMPANION_SESSION_ID: "session-1",
          COMPANION_SESSION_NUMBER: "2220",
          TAKODE_ROLE: "orchestrator",
        },
      },
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("[mcp_servers.takode_delegate]");
    expect(config).toContain(`command = ${JSON.stringify(process.execPath)}`);
    expect(config).toContain('args = ["/repo/web/bin/takode-delegate-mcp.ts"]');
    expect(config).toContain("enabled = true");
    expect(config).toContain("[mcp_servers.takode_delegate.env]");
    expect(config).toContain('COMPANION_AUTH_TOKEN = "secret-token"');
    expect(config).toContain('COMPANION_PORT = "3456"');
    expect(config).toContain('COMPANION_SESSION_ID = "session-1"');
    expect(config).toContain('COMPANION_SESSION_NUMBER = "2220"');
    expect(config).toContain('TAKODE_ROLE = "orchestrator"');
  });

  it("registers the delegate MCP server for delegate child sessions", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, 'model = "takode-test-child"\n', "utf-8");

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model: "takode-test-child",
      takodeDelegateMcp: {
        enabled: true,
        command: process.execPath,
        args: ["/repo/web/bin/takode-delegate-mcp.ts"],
        env: {
          COMPANION_AUTH_TOKEN: "child-token",
          COMPANION_PORT: "3456",
          COMPANION_SESSION_ID: "child-session",
          TAKODE_DELEGATE_ID: "del_123",
          TAKODE_DELEGATE_PARENT_SESSION_ID: "parent-session",
          TAKODE_DELEGATE_ROLE: "child",
        },
      },
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("[mcp_servers.takode_delegate]");
    expect(config).toContain('TAKODE_DELEGATE_ROLE = "child"');
    expect(config).toContain('TAKODE_DELEGATE_ID = "del_123"');
    expect(config).toContain('TAKODE_DELEGATE_PARENT_SESSION_ID = "parent-session"');
  });

  it("removes the Takode delegate MCP server when a launch is not a leader", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    await writeFile(
      configPath,
      [
        'model = "takode-test-worker"',
        "",
        "[mcp_servers.takode_delegate]",
        'command = "/old/bun"',
        'args = ["/old/server.ts"]',
        "enabled = true",
        "[mcp_servers.takode_delegate.env]",
        'COMPANION_SESSION_ID = "old"',
        "",
      ].join("\n"),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model: "takode-test-worker",
      takodeDelegateMcp: {
        enabled: false,
        command: process.execPath,
        args: ["/repo/web/bin/takode-delegate-mcp.ts"],
        env: {},
      },
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).not.toContain("[mcp_servers.takode_delegate]");
    expect(config).not.toContain("[mcp_servers.takode_delegate.env]");
    expect(config).not.toContain("/old/server.ts");
  });

  it("derives the leader display budget from source effective context and inflates the provider envelope", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-large";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 600_000,
            max_context_window: 600_000,
            effective_context_window_percent: 95,
            auto_compact_token_limit: null,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], { model });

    // The leader recycle/display budget uses source effective context (600K * 95%)
    // minus the fixed 25K buffer. The provider envelope is much larger so
    // Codex built-in compaction remains behind Takode leader recycling.
    expect(result.leaderRecycleThresholdTokens).toBe(545_000);
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("model_context_window = 3027778");
    expect(config).toContain("model_auto_compact_token_limit = 2725000");

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models[0]).toMatchObject({
      context_window: 3_027_778,
      max_context_window: 3_027_778,
      effective_context_window_percent: 95,
      auto_compact_token_limit: 2_725_000,
    });
  });

  it("uses normal context capacity config when leader recycling is disabled", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "takode-test-compact-leader";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 600_000,
            max_context_window: 600_000,
            effective_context_window_percent: 95,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      codexContextCapacityTokens: 545_000,
      model,
    });

    // Compaction-mode leaders use the normal effective context target instead
    // of inflating Codex behind Takode's recycle budget.
    expect(result.leaderRecycleThresholdTokens).toBeUndefined();
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    expect(config).toContain("model_context_window = 573685");
    expect(config).not.toContain("model_auto_compact_token_limit = 2725000");

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models[0]).toMatchObject({
      context_window: 573_685,
      max_context_window: 573_685,
      effective_context_window_percent: 95,
    });
  });

  it("requests Codex reasoning summaries when the selected model supports them", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const model = "gpt-5.6-sol";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            supports_reasoning_summaries: true,
            default_reasoning_summary: "none",
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
    });

    expect(result.reasoningSummaryLaunchMode).toBe("auto");
    const config = await readFile(configPath, "utf-8");
    expect(config).not.toContain("model_reasoning_summary");
  });

  it("does not request Codex reasoning summaries when the selected model does not support them", async () => {
    const codexHome = await makeCodexHome();
    const model = "takode-no-summary-model";
    await writeFile(join(codexHome, "config.toml"), `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            supports_reasoning_summaries: false,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
    });

    expect(result.reasoningSummaryLaunchMode).toBeUndefined();
  });

  it("preserves an explicit disabled Codex reasoning summary setting", async () => {
    const codexHome = await makeCodexHome();
    const model = "gpt-5.6-sol";
    await writeFile(
      join(codexHome, "config.toml"),
      [`model = "${model}"`, 'model_reasoning_summary = "none"', ""].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            supports_reasoning_summaries: true,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
    });

    expect(result.reasoningSummaryLaunchMode).toBeUndefined();
    const config = await readFile(join(codexHome, "config.toml"), "utf-8");
    expect(config).toContain('model_reasoning_summary = "none"');
  });

  it("uses an explicit non-disabled Codex reasoning summary setting as the launch mode", async () => {
    const codexHome = await makeCodexHome();
    const model = "gpt-5.6-sol";
    await writeFile(
      join(codexHome, "config.toml"),
      [`model = "${model}"`, 'model_reasoning_summary = "detailed"', ""].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: model, base_instructions: PROMPT, supports_reasoning_summaries: false }] }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
    });

    expect(result.reasoningSummaryLaunchMode).toBe("detailed");
    const config = await readFile(join(codexHome, "config.toml"), "utf-8");
    expect(config).toContain('model_reasoning_summary = "detailed"');
  });

  it("requests Codex reasoning summaries from installed catalog metadata when session caches are stale", async () => {
    const codexHome = await makeCodexHome();
    const model = "gpt-5.6-sol";
    await writeFile(join(codexHome, "config.toml"), `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.5",
            base_instructions: PROMPT,
            supports_reasoning_summaries: true,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      loadInstalledModelCatalog: async () => ({
        source: "installed-cli",
        models: [
          {
            value: model,
            canonicalIdentity: model,
            routeEntryFingerprint: "f".repeat(64),
            label: "GPT-5.6-Sol",
            description: "Latest frontier agentic coding model.",
            supportsReasoningSummaries: true,
          },
        ],
      }),
    });

    expect(result.reasoningSummaryLaunchMode).toBe("auto");
  });

  it("disables Responses Lite for MAI LiteLLM leader catalog overrides", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "gpt-5.6-sol";
    await writeFile(configPath, [`model_provider = "mai-litellm"`, `model = "${model}"`, ""].join("\n"), "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 372_000,
            max_context_window: 372_000,
            effective_context_window_percent: 95,
            use_responses_lite: true,
          },
        ],
      }),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], { model });

    const config = await readFile(configPath, "utf-8");
    expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models[0]).toMatchObject({
      slug: model,
      base_instructions: PROMPT,
      use_responses_lite: false,
      context_window: 1_824_445,
      max_context_window: 1_824_445,
      auto_compact_token_limit: 1_642_000,
    });
  });

  it("uses configured usable capacity as the leader display budget while preserving the hidden provider envelope", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-leader-configured";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 600_000,
            max_context_window: 600_000,
            effective_context_window_percent: 95,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      model,
      codexContextCapacityTokens: 660_000,
    });

    expect(result.leaderRecycleThresholdTokens).toBe(660_000);
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("model_context_window = 3666667");
    expect(config).toContain("model_auto_compact_token_limit = 3300000");

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models[0]).toMatchObject({
      context_window: 3_666_667,
      max_context_window: 3_666_667,
      effective_context_window_percent: 95,
      auto_compact_token_limit: 3_300_000,
    });
  });

  it("preserves an existing leader display budget across model-only relaunch", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "gpt-5.6-sol";
    await writeFile(configPath, ['model_provider = "mai-litellm"', 'model = "' + model + '"', ""].join("\n"), "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 372_000,
            max_context_window: 372_000,
            effective_context_window_percent: 95,
            use_responses_lite: true,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      model,
      existingLeaderRecycleThresholdTokens: 545_000,
    });

    expect(result.leaderRecycleThresholdTokens).toBe(545_000);
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("model_catalog_json = " + JSON.stringify(catalogPath));
    expect(config).toContain("model_context_window = 3027778");
    expect(config).toContain("model_auto_compact_token_limit = 2725000");

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models[0]).toMatchObject({
      slug: model,
      base_instructions: PROMPT,
      context_window: 3_027_778,
      max_context_window: 3_027_778,
      effective_context_window_percent: 95,
      auto_compact_token_limit: 2_725_000,
      use_responses_lite: false,
    });
  });

  it("does not derive relaunch thresholds from Takode's generated leader catalog", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-relaunch";
    await writeFile(
      configPath,
      [
        `model = "${model}"`,
        "model_context_window = 631053",
        "model_auto_compact_token_limit = 599500",
        `model_catalog_json = ${JSON.stringify(catalogPath)}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      catalogPath,
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 631_053,
            max_context_window: 631_053,
            effective_context_window_percent: 95,
            auto_compact_token_limit: 599_500,
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], { model });

    // Relaunch prep must not treat Takode's own generated leader catalog or
    // top-level guard values as source model capacity, or thresholds drift up.
    expect(result.leaderRecycleThresholdTokens).toBe(260_000);
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("model_context_window = 1444445");
    expect(config).toContain("model_auto_compact_token_limit = 1300000");
  });

  it("reuses trusted launch-derived threshold metadata when relaunch sees only the generated leader catalog", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-gpt55";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            context_window: 922_000,
            max_context_window: 922_000,
            effective_context_window_percent: 95,
            auto_compact_token_limit: null,
          },
        ],
      }),
      "utf-8",
    );

    const firstLaunch = await _ensureCodexSessionConfigForTest(codexHome, [], { model });
    expect(firstLaunch.leaderRecycleThresholdTokens).toBe(850_900);
    expect(firstLaunch.leaderLaunchConfig).toMatchObject({
      model,
      sourceEffectiveContextWindowTokens: 875_900,
      recycleThresholdTokens: 850_900,
    });

    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");
    const relaunch = await _ensureCodexSessionConfigForTest(codexHome, [], {
      model,
      trustedPreviousLeaderRecycleResolution: {
        model,
        recycleThresholdTokens: firstLaunch.leaderLaunchConfig!.recycleThresholdTokens,
        sourceEffectiveContextWindowTokens: firstLaunch.leaderLaunchConfig!.sourceEffectiveContextWindowTokens,
      },
    });

    // Regression for q-81: relaunch after Takode rewrote model_catalog_json to
    // takode-leader-model-catalog.json must not degrade to the 260K fallback.
    expect(relaunch.leaderLaunchConfig).toMatchObject({
      model,
      source: "previous-launch",
      sourceEffectiveContextWindowTokens: 875_900,
      recycleThresholdTokens: 850_900,
      modelContextWindow: 4_727_223,
      modelAutoCompactTokenLimit: 4_254_500,
      modelCatalogConfigPath: catalogPath,
    });
    const config = await readFile(configPath, "utf-8");
    expect(config).toContain("model_context_window = 4727223");
    expect(config).toContain("model_auto_compact_token_limit = 4254500");
    expect(config).not.toContain("model_context_window = 1444445");
  });

  it("does not reuse trusted launch-derived threshold metadata for a different model", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-new-model";
    await writeFile(
      configPath,
      [`model = "${model}"`, `model_catalog_json = ${JSON.stringify(catalogPath)}`, ""].join("\n"),
      "utf-8",
    );
    await writeFile(
      catalogPath,
      JSON.stringify({
        models: [
          {
            slug: model,
            context_window: 4_727_223,
            max_context_window: 4_727_223,
            effective_context_window_percent: 95,
            auto_compact_token_limit: 4_254_500,
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");

    const relaunch = await _ensureCodexSessionConfigForTest(codexHome, [], {
      model,
      trustedPreviousLeaderRecycleResolution: {
        model: "takode-test-old-model",
        recycleThresholdTokens: 850_900,
        sourceEffectiveContextWindowTokens: 875_900,
      },
    });

    // The preserved value is trusted only for the same model; otherwise falling
    // back is safer than assigning another model's source context.
    expect(relaunch.leaderRecycleThresholdTokens).toBe(260_000);
    expect(relaunch.leaderLaunchConfig).toMatchObject({
      model,
      source: "fallback",
      recycleThresholdTokens: 260_000,
      modelContextWindow: 1_444_445,
      modelAutoCompactTokenLimit: 1_300_000,
    });
  });

  it("does not reuse migrated threshold metadata when the prior model is unknown", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-migrated-model";
    await writeFile(
      configPath,
      [`model = "${model}"`, `model_catalog_json = ${JSON.stringify(catalogPath)}`, ""].join("\n"),
      "utf-8",
    );
    await writeFile(
      catalogPath,
      JSON.stringify({
        models: [
          {
            slug: model,
            context_window: 4_727_223,
            max_context_window: 4_727_223,
            effective_context_window_percent: 95,
            auto_compact_token_limit: 4_254_500,
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");

    const relaunch = await _ensureCodexSessionConfigForTest(codexHome, [], {
      model,
      trustedPreviousLeaderRecycleResolution: {
        recycleThresholdTokens: 850_900,
        sourceEffectiveContextWindowTokens: 875_900,
      },
    });

    // Older persisted sessions can have a threshold but no model lineage. That
    // metadata is not enough to prove the threshold belongs to the current
    // launch model, so relaunch must keep the conservative fallback behavior.
    expect(relaunch.leaderRecycleThresholdTokens).toBe(260_000);
    expect(relaunch.leaderLaunchConfig).toMatchObject({
      model,
      source: "fallback",
      recycleThresholdTokens: 260_000,
      modelContextWindow: 1_444_445,
      modelAutoCompactTokenLimit: 1_300_000,
    });
  });

  it("cleans legacy Takode non-leader catalog references without touching user context settings", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "takode-test-worker";
    await writeFile(
      configPath,
      [
        `model = "${model}"`,
        `model_catalog_json = ${JSON.stringify(catalogPath)}`,
        "model_context_window = 600000",
        "model_auto_compact_token_limit = 510000",
        'model_auto_compact_token_limit_scope = "total"',
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      catalogPath,
      JSON.stringify({ models: [{ slug: model, base_instructions: PROMPT, auto_compact_token_limit: 510000 }] }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      nonLeaderAutoCompactThresholdPercent: 90,
      model,
    });

    const config = await readFile(configPath, "utf-8");
    // q-1450: only the Takode-owned catalog reference is removed. User-owned
    // Codex context and compact settings are left for Codex itself to honor.
    expect(config).not.toContain("model_catalog_json");
    expect(config).toContain("model_context_window = 600000");
    expect(config).toContain("model_auto_compact_token_limit = 510000");
    expect(config).toContain('model_auto_compact_token_limit_scope = "total"');
    expect(result.modelCatalogJson).toBeUndefined();

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models[0].auto_compact_token_limit).toBe(510000);
  });

  it("preserves custom non-leader model catalog settings", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const customCatalogPath = join(codexHome, "custom-models.json");
    const model = "takode-test-worker";
    await writeFile(
      configPath,
      [`model = "${model}"`, `model_catalog_json = ${JSON.stringify(customCatalogPath)}`, ""].join("\n"),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      nonLeaderAutoCompactThresholdPercent: 90,
      model,
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).toContain(`model_catalog_json = ${JSON.stringify(customCatalogPath)}`);
  });

  it("writes a non-leader selected-model catalog override from desired usable capacity", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "takode-test-worker-usable";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 300_000,
            max_context_window: 300_000,
            effective_context_window_percent: 80,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      codexContextCapacityTokens: 400_000,
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    expect(config).toContain("model_context_window = 500000");
    expect(config).toContain("model_auto_compact_token_limit = 360000");
    expect(result.contextLaunchConfig).toEqual({
      modelContextWindow: 500_000,
      modelAutoCompactTokenLimit: 360_000,
      catalogEffectiveContextWindowPercent: 80,
      modelCatalogConfigPath: catalogPath,
    });

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expectParserSafeEntry(catalog.models[0], model);
    expect(catalog.models[0]).toMatchObject({
      context_window: 500_000,
      max_context_window: 500_000,
      effective_context_window_percent: 80,
      auto_compact_token_limit: 360_000,
    });
  });

  it("writes a MAI LiteLLM compatibility catalog override for non-leader Responses Lite models", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "gpt-5.6-sol";
    await writeFile(configPath, [`model_provider = "mai-litellm"`, `model = "${model}"`, ""].join("\n"), "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 372_000,
            max_context_window: 372_000,
            effective_context_window_percent: 95,
            use_responses_lite: true,
          },
        ],
      }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    expect(result.modelCatalogJson).toBeDefined();
    expect(result.contextLaunchConfig).toBeUndefined();
    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models[0]).toMatchObject({
      slug: model,
      base_instructions: PROMPT,
      context_window: 372_000,
      max_context_window: 372_000,
      use_responses_lite: false,
    });
  });

  it("clears Takode-owned non-leader context override without removing unrelated context settings", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "takode-test-worker-clear";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: model, base_instructions: PROMPT }] }),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      codexContextCapacityTokens: 400_000,
    });
    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).not.toContain("model_catalog_json");
    expect(config).not.toContain("model_context_window");
    expect(config).not.toContain("model_auto_compact_token_limit");
  });

  it.each([
    "v1",
    "v2",
  ] as const)("clears a prior Takode context override while retaining selected multi-agent %s", async (multiAgentVersion) => {
    // All newly launched Codex sessions carry a selected V1/V2 catalog entry.
    // Clearing max-context must rebuild that entry from source metadata rather
    // than preserve Takode's old context and auto-compact values in the catalog.
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-model-catalog.json");
    const model = `takode-test-clear-${multiAgentVersion}`;
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 300_000,
            max_context_window: 300_000,
            effective_context_window_percent: 80,
            multi_agent_version: multiAgentVersion,
          },
        ],
      }),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      codexContextCapacityTokens: 400_000,
      multiAgentVersion,
    });
    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      multiAgentVersion,
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).toContain(`model_catalog_json = ${JSON.stringify(catalogPath)}`);
    expect(config).not.toContain("model_context_window");
    expect(config).not.toContain("model_auto_compact_token_limit");
    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    const entry = catalog.models.find((candidate: Record<string, unknown>) => candidate.slug === model);
    expect(entry).toMatchObject({
      context_window: 300_000,
      max_context_window: 300_000,
      effective_context_window_percent: 80,
      multi_agent_version: multiAgentVersion,
    });
    expect(entry).not.toHaveProperty("auto_compact_token_limit");
  });

  it.each([
    ["v2", "v2"],
    ["v2", "v1"],
    ["v1", "v2"],
  ] as const)("preserves custom catalog metadata across selected %s then %s launches", async (firstVersion, secondVersion) => {
    // Once Takode selects a native multi-agent version, config points at the
    // generated catalog. Repeated launches must still rebuild from the user's
    // original custom metadata rather than an empty/default models cache.
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const customCatalogPath = join(codexHome, "custom-models.json");
    const generatedCatalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "custom-model";
    await writeFile(
      configPath,
      [`model = "${model}"`, `model_catalog_json = ${JSON.stringify(customCatalogPath)}`, ""].join("\n"),
      "utf-8",
    );
    await writeFile(
      customCatalogPath,
      JSON.stringify({
        custom_transport: { protocol: "custom-rpc" },
        models: [
          {
            slug: model,
            base_instructions: "Keep these user-authored instructions.",
            custom_transport: { route: "private-model-route" },
          },
          { slug: "other-custom-model", base_instructions: PROMPT, custom_marker: "preserve-me" },
        ],
      }),
      "utf-8",
    );
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      multiAgentVersion: firstVersion,
    });
    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      multiAgentVersion: secondVersion,
    });

    const catalog = JSON.parse(await readFile(generatedCatalogPath, "utf-8"));
    expect(catalog.custom_transport).toEqual({ protocol: "custom-rpc" });
    expect(catalog.models.find((entry: Record<string, unknown>) => entry.slug === "other-custom-model")).toMatchObject({
      custom_marker: "preserve-me",
    });
    expect(catalog.models.find((entry: Record<string, unknown>) => entry.slug === model)).toMatchObject({
      base_instructions: "Keep these user-authored instructions.",
      custom_transport: { route: "private-model-route" },
      multi_agent_version: secondVersion,
    });
  });

  it("restores custom source metadata when clearing a Takode-owned context override", async () => {
    // Context-capacity launch values are Takode-owned, but the catalog around
    // them is not. Clearing capacity must restore the original entry fields and
    // retain custom metadata while applying the newly selected V1/V2 version.
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const customCatalogPath = join(codexHome, "custom-models.json");
    const generatedCatalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "custom-context-model";
    await writeFile(
      configPath,
      [`model = "${model}"`, `model_catalog_json = ${JSON.stringify(customCatalogPath)}`, ""].join("\n"),
      "utf-8",
    );
    await writeFile(
      customCatalogPath,
      JSON.stringify({
        catalog_owner: "user",
        models: [
          {
            slug: model,
            base_instructions: "Custom baseline",
            custom_transport: "user-route",
            context_window: 300_000,
            max_context_window: 300_000,
            effective_context_window_percent: 80,
          },
        ],
      }),
      "utf-8",
    );
    await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [] }), "utf-8");

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      codexContextCapacityTokens: 400_000,
      multiAgentVersion: "v2",
    });
    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      multiAgentVersion: "v1",
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).not.toContain("model_context_window");
    expect(config).not.toContain("model_auto_compact_token_limit");
    const catalog = JSON.parse(await readFile(generatedCatalogPath, "utf-8"));
    expect(catalog.catalog_owner).toBe("user");
    const entry = catalog.models.find((candidate: Record<string, unknown>) => candidate.slug === model);
    expect(entry).toMatchObject({
      base_instructions: "Custom baseline",
      custom_transport: "user-route",
      context_window: 300_000,
      max_context_window: 300_000,
      effective_context_window_percent: 80,
      multi_agent_version: "v1",
    });
    expect(entry).not.toHaveProperty("auto_compact_token_limit");
  });

  it.each([
    ["stale", 'model = "other-model"\n'],
    ["missing", ""],
  ] as const)("clears selected-model context overrides when the config model is %s", async (_case, modelConfig) => {
    // The launch option is authoritative. A stale or absent top-level model must
    // not strand context values that Takode generated for the actually selected model.
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const generatedCatalogPath = join(codexHome, "takode-model-catalog.json");
    const model = "selected-model";
    await writeFile(configPath, modelConfig, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: model,
            base_instructions: PROMPT,
            context_window: 300_000,
            max_context_window: 300_000,
            effective_context_window_percent: 80,
          },
          { slug: "other-model", base_instructions: PROMPT, context_window: 200_000 },
        ],
      }),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      codexContextCapacityTokens: 400_000,
      multiAgentVersion: "v2",
    });
    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      multiAgentVersion: "v2",
    });

    const config = await readFile(configPath, "utf-8");
    expect(config).not.toContain("model_context_window");
    expect(config).not.toContain("model_auto_compact_token_limit");
    const catalog = JSON.parse(await readFile(generatedCatalogPath, "utf-8"));
    expect(catalog.models.find((entry: Record<string, unknown>) => entry.slug === model)).toMatchObject({
      context_window: 300_000,
      max_context_window: 300_000,
      effective_context_window_percent: 80,
      multi_agent_version: "v2",
    });
  });

  it("adds a missing selected model to an otherwise valid catalog", async () => {
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const sourceCatalogPath = join(codexHome, "models_cache.json");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "other-model-preview";
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await writeFile(
      sourceCatalogPath,
      JSON.stringify({ models: [{ slug: "other-model", base_instructions: PROMPT, context_window: 1000 }] }, null, 2),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderRecycleThresholdTokens: 260_000,
      model,
    });

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models.map((entry: Record<string, unknown>) => entry.slug)).toEqual(["other-model", model]);
    const added = catalog.models.find((entry: Record<string, unknown>) => entry.slug === model);
    expectParserSafeEntry(added, model);
    // Codex's own prefix lookup resolves the missing model to the known entry.
    expect(added).toMatchObject({
      base_instructions: PROMPT,
      context_window: 1_444_445,
      max_context_window: 1_444_445,
      auto_compact_token_limit: 1_300_000,
    });
  });

  it("repairs every catalog entry, not only the selected model, and normalizes reasoning levels", async () => {
    // Codex parses the whole supplied catalog at startup, so a malformed entry for
    // another model breaks the launch just as a malformed selected entry would.
    const codexHome = await makeCodexHome();
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-selected";
    await writeFile(join(codexHome, "config.toml"), `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          {
            slug: "other-model",
            base_instructions: PROMPT,
            supported_reasoning_levels: ["low", { effort: "high" }, { description: "no effort" }],
          },
          {
            slug: model,
            base_instructions: PROMPT,
            supported_reasoning_levels: [{ effort: "medium", description: "Balanced", extra: "kept" }],
          },
        ],
      }),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderRecycleThresholdTokens: 260_000,
      model,
    });

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    const [other, selected] = catalog.models;
    expectParserSafeEntry(other, "other-model");
    expect(other.supported_reasoning_levels).toEqual([
      { effort: "low", description: "" },
      { effort: "high", description: "" },
    ]);
    expectParserSafeEntry(selected, model);
    expect(selected.supported_reasoning_levels).toEqual([{ effort: "medium", description: "Balanced", extra: "kept" }]);
  });

  // A session written by an older Takode holds a prompt-less stub for a model no
  // catalog knows; relaunch prep removes it so Codex uses its generic prompt.
  it("removes a legacy prompt-less stub for an unknown model during relaunch prep", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "takode-test-repair";
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configPath,
      [`model = "${model}"`, `model_catalog_json = ${JSON.stringify(catalogPath)}`, ""].join("\n"),
      "utf-8",
    );
    await writeFile(catalogPath, JSON.stringify({ models: [{ slug: model }] }, null, 2), "utf-8");

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderRecycleThresholdTokens: 260_000,
      model,
      loadBundledModelCatalog: async () => ({ models: [] }),
    });

    const catalog = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(catalog.models).toEqual([]);
    warn.mockRestore();
  });

  it("uses container catalog paths in generated config while writing the host-side catalog content", async () => {
    const codexHome = await makeCodexHome();
    const containerCatalogPath = "/root/.codex/takode-leader-model-catalog.json";
    const model = "takode-test-container";
    await writeFile(join(codexHome, "config.toml"), `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: model, base_instructions: PROMPT }] }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderRecycleThresholdTokens: 260_000,
      model,
      modelCatalogConfigPath: containerCatalogPath,
    });

    expect(result.configToml).toContain(`model_catalog_json = ${JSON.stringify(containerCatalogPath)}`);
    expect(result.modelCatalogJson).toBeDefined();
    const catalog = JSON.parse(result.modelCatalogJson!);
    const entry = catalog.models.find((candidate: Record<string, unknown>) => candidate.slug === model);
    expectParserSafeEntry(entry, model);
  });

  it.each([
    ["v1", "v2", false],
    ["v2", "v1", true],
  ] as const)("forces selected multi-agent %s over conflicting model metadata", async (selectedVersion, sourceVersion, v2Enabled) => {
    // Model metadata has higher precedence than feature flags inside Codex.
    // The generated session catalog must therefore carry Takode's selection.
    const codexHome = await makeCodexHome();
    const model = `takode-test-${selectedVersion}`;
    await writeFile(join(codexHome, "config.toml"), `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: model, base_instructions: PROMPT, multi_agent_version: sourceVersion }] }),
      "utf-8",
    );

    const result = await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: false,
      model,
      multiAgentVersion: selectedVersion,
    });

    expect(result.configToml).toContain("multi_agent = true");
    expect(result.configToml).toContain(`multi_agent_v2 = ${v2Enabled}`);
    const catalog = JSON.parse(await readFile(join(codexHome, "takode-model-catalog.json"), "utf-8"));
    const entry = catalog.models.find((candidate: Record<string, unknown>) => candidate.slug === model);
    expectParserSafeEntry(entry, model);
    expect(entry.multi_agent_version).toBe(selectedVersion);
  });

  it("preserves the selected V2 version in leader context-guard catalog generation", async () => {
    // Leaders stay on V1 in normal product routing, but the shared launch helper must
    // remain correct when an explicit selection reaches the leader catalog branch.
    const codexHome = await makeCodexHome();
    const model = "takode-test-leader-v2";
    await writeFile(join(codexHome, "config.toml"), `model = "${model}"\n`, "utf-8");
    await writeFile(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [{ slug: model, base_instructions: PROMPT, multi_agent_version: "v1", context_window: 800_000 }],
      }),
      "utf-8",
    );

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: true,
      existingLeaderRecycleThresholdTokens: 260_000,
      model,
      multiAgentVersion: "v2",
    });

    const catalog = JSON.parse(await readFile(join(codexHome, "takode-leader-model-catalog.json"), "utf-8"));
    const entry = catalog.models.find((candidate: Record<string, unknown>) => candidate.slug === model);
    expect(entry.multi_agent_version).toBe("v2");
  });

  it("builds a catalog from the CLI's bundled models when no models_cache.json exists, then heals it on relaunch", async () => {
    // GitHub Copilot providers never write models_cache.json. Takode used to write a
    // one-model catalog with an empty base prompt there, so Codex ran with no
    // built-in prompt. Now the bundled entries (with their prompts) are the source,
    // and a generated catalog re-read on relaunch keeps them.
    const codexHome = await makeCodexHome();
    const configPath = join(codexHome, "config.toml");
    const catalogPath = join(codexHome, "takode-leader-model-catalog.json");
    const model = "gpt-6-astra";
    const bundledEntry = (slug: string) => ({
      slug,
      display_name: slug,
      shell_type: "unified_exec",
      base_instructions: `Built-in prompt for ${slug}`,
      model_messages: { instructions_template: `Built-in prompt for ${slug}` },
      context_window: 272_000,
      max_context_window: 872_000,
    });
    const loadBundledModelCatalog = async () => ({ models: [bundledEntry(model), bundledEntry("gpt-5.5")] });
    // A catalog an older Takode wrote: the session config already points at it.
    await writeFile(
      catalogPath,
      JSON.stringify({ models: [{ slug: model, base_instructions: "", shell_type: "shell_command" }] }),
      "utf-8",
    );
    await writeFile(configPath, `model = "${model}"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`, "utf-8");

    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: true,
      existingLeaderRecycleThresholdTokens: 260_000,
      model,
      loadBundledModelCatalog,
    });

    const healed = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(healed.models[0]).toMatchObject({
      slug: model,
      shell_type: "unified_exec",
      model_messages: { instructions_template: `Built-in prompt for ${model}` },
      context_window: 1_444_445,
      auto_compact_token_limit: 1_300_000,
    });

    // Without any catalog file, the bundled catalog is the source, other models included.
    await rm(catalogPath);
    await writeFile(configPath, `model = "${model}"\n`, "utf-8");
    await _ensureCodexSessionConfigForTest(codexHome, [], {
      leaderLaunch: true,
      existingLeaderRecycleThresholdTokens: 260_000,
      model,
      loadBundledModelCatalog,
    });

    const fresh = JSON.parse(await readFile(catalogPath, "utf-8"));
    expect(fresh.models.map((entry: { slug: string }) => entry.slug)).toEqual([model, "gpt-5.5"]);
    expect(fresh.models[0]).toMatchObject({
      base_instructions: `Built-in prompt for ${model}`,
      context_window: 1_444_445,
    });
  });
});

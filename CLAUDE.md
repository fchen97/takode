# CLAUDE.md

This file provides guidance to Claude Code & Codex when working with code in this repository.

## What This Is

Takode — a web orchestration UI for Claude Code & Codex.
It began as a Companion fork and now provides a multi-session workspace with cross-session coordination, Questmaster workflows, tool-call visibility, and permission control.

## Project Progress

Use Questmaster to track project progress for this repository. Treat project tasks/todos as quests and keep status current via the `quest` CLI and Questmaster workflow.

Questmaster tags should follow the generated quest skill's small generic two-axis taxonomy: refined-and-later quests generally use one area tag plus one work-type tag, while specific project/component nouns belong in title/TLDR/description/search instead of tags. Keep public tag-guidance examples mocked rather than using real project, repo, component, feature, or product names.

## Durable User Data Safety

Before any action that could delete, reset, overwrite, migrate, or bulk-mutate durable user data, verify the target, isolation, and recovery path. Durable user data includes Questmaster records, sessions, memory, settings, worktrees, images/artifacts, and other user-owned state.

Treat destructive tests and helpers as dangerous until their data paths are proven isolated to temporary or disposable state. Before destructive operations against durable user data, have a backup, snapshot, or explicit recovery plan; if isolation or recovery status is uncertain, stop and route for approval. Standard approved workflows may proceed when their documented steps provide verified isolation or recovery.

## Skills

The repo's skills come in two kinds:

- **Global skills** are part of Takode as a product: sessions need them in any repository. They are listed in `GLOBAL_SKILL_SLUGS` (`web/server/skill-symlink.ts`), and the server and every `takode node` link them into `~/.claude/skills/` and `~/.agents/skills/` at startup.
- **Project skills** are about developing Takode. They are every other skill in the repo, and they load only when a session works inside the Takode repo or one of its worktrees, as ordinary project skills: Claude reads the repo's `.claude/skills/`, and Codex reads only the repo's `.agents/skills/`. Startup removes global links into the repo for any skill not in the list, so a skill moved out of the list, or deleted, leaves the global folders on the next start.

A new skill is a project skill unless it belongs in the list. Add it to `GLOBAL_SKILL_SLUGS` only when sessions outside the Takode repo need it; global skills reach every session and are hard to scope later, so avoid them for context-dependent instructions and prefer repo instruction files in known locations, injected or referenced only for the agents that need them.

The canonical source is `.claude/skills/<slug>/`. Give a project skill a relative link `.agents/skills/<slug> -> ../../.claude/skills/<slug>` so Codex finds it too; use a real `.agents/skills/<slug>/` folder only when a distinct non-Claude source is needed (the global install prefers it for `~/.agents/skills/` and otherwise falls back to `.claude/skills/`). A skill that exists only under `.agents/skills/` never reaches Claude sessions. Legacy `.codex/skills/` content is compatibility-only and may be migrated into `.agents`; do not add skills there.

For Takode-wide cluster usage, runbook, or agent/skill documentation work, first look for any local/private cluster docs outside this tracked repository. Treat those docs as optional local context that may not exist on every machine, and keep tracked repo guidance generic. Do not copy sensitive cluster details into tracked files.

### Design Decisions as Skills

For Takode repo work only, leaders should proactively propose focused repo-level design-principle skills when a user describes reusable guidance or when repeated failures suggest codified guidance would prevent recurrence. These skills should explain the principle, motivation, and practical application. Their frontmatter descriptions must clearly state when future agents should read them, using concrete trigger terms rather than vague names.

If an implementation plan or user proposal conflicts with an existing design-principle skill, surface the conflict before changing code and decide whether to update the principle or revise the proposal. Design-principle skills are project skills: keep them out of `GLOBAL_SKILL_SLUGS` and follow the source boundaries above. This is a Takode-repo instruction, not a universal rule for other repositories.

| Skill | Scope | Source | Purpose |
|-------|-------|--------|---------|
| `takode-orchestration` | Global | `.claude/skills/takode-orchestration/` | Cross-session orchestration: CLI reference, quest journey, board, herd events |
| `leader-dispatch` | Global | `.claude/skills/leader-dispatch/` | Leader dispatch workflow: worker selection, templates, discipline rules |
| `leader-decision-communication` | Global | `.claude/skills/leader-decision-communication/` | Decision-first, plain-language leader prompts and status updates with a material-detail necessity filter |
| `explain-clearly` | Global | `.claude/skills/explain-clearly/` | High-level preferences and anti-patterns for natural substantial explanations and informative artifacts |
| `confirm` | Global | `.claude/skills/confirm/` | Confirmation workflow for instruction-scoped `/confirm` requests |
| `quest-design` | Global | `.claude/skills/quest-design/` | Confirmation workflow before creating or refining quests |
| `self-groom` | Global | `.claude/skills/self-groom/` | Multi-perspective self-review via parallel subagents |
| `reviewer-groom` | Global | `.claude/skills/reviewer-groom/` | Reviewer-owned quality review for another agent's change |
| `skeptic-review` | Global | `.claude/skills/skeptic-review/` | Adversarial work integrity review of worker output |
| `worktree-rules` (`/port-changes`) | Global | `.claude/skills/worktree-rules/` | Worktree-to-main-repo porting workflow; `worktree-rules` is the underlying skill slug and `/port-changes` is the user-facing command/alias |
| `takode-user-content` | Global | `.claude/skills/takode-user-content/` | Agent procedure for setting up, migrating and repairing the user's Takode-managed instructions and skills (Settings hands this job to a session) |
| `self-improvement` | Global | `.claude/skills/self-improvement/` | Turn a correction or repeated mistake into a proposed quest for an instruction, skill, prompt or code change |
| `guided-review` | Global | `.claude/skills/guided-review/` | Only when the user asks for a code review they will read: write, publish and share a guided review (`takode review`), a walkthrough of a git range with inline questions and code from git |
| `visual-blocks` | Global | `.claude/skills/visual-blocks/` | When a picture beats prose in an answer, report or guided review: the ```visual block, Takode's visual kit, the Mermaid and chart helpers, and `takode visual preview` before publishing |
| `takode-orchestration-design` | Project | `.claude/skills/takode-orchestration-design/` | Placement rubric for Takode leader/worker/reviewer orchestration guidance and phase instruction design |
| `takode-cli-design` | Project | `.claude/skills/takode-cli-design/`, `.agents/skills/takode-cli-design/` | Progressive Takode CLI output design: compact defaults, explicit detail/include paths, bulky-field guardrails, and no opaque IDs or hashes for agents unless they need the exact value |
| `takode-injected-message-design` | Project | `.claude/skills/takode-injected-message-design/`, `.agents/skills/takode-injected-message-design/` | Design guardrails for Takode injected messages and reminders: interrupted-generation skip decisions, and the feed rule that Takode-injected messages render as collapsed chips through one shared component while conversation stays in bubbles |
| `takode-agent-run-workflows` | Project | `.claude/skills/takode-agent-run-workflows/` | When to build rarely used, failure-prone features and workflows (setup, migration, repair) as instructions an agent follows, with UI or code only as the entry point, instead of dedicated UI and rigid logic |
| `takode-codex-session-safety` | Project | `.claude/skills/takode-codex-session-safety/`, `.agents/skills/takode-codex-session-safety/` | Guardrails for Codex `skills/changed`, skill/app metadata refresh, close-wave diagnostics, browser-open recovery triggers, and image attachment transport |
| `takode-mobile-ui-design` | Project | `.claude/skills/takode-mobile-ui-design/`, `.agents/skills/takode-mobile-ui-design/` | The user's phone UI preferences and why: thumb reach for actions with identity kept on top, context next to its control, smallest change, calm and non-redundant density, dropdowns over uneven chip rows for open-ended values, native touch behavior, no jumps under the finger, and real-implementation design options |
| `takode-ui-e2e-validation` | Project | `.claude/skills/takode-ui-e2e-validation/` | Takode UI/E2E validation with `agent-browser`, leases, shared persistent validation state by default, isolated exceptions, Playground coverage, and screenshot evidence |

Additionally, `quest-integration.ts` generates and installs the `quest` skill docs (from `web/server/templates/quest-skill-docs.md`) and the `memory` skill (from `web/server/templates/memory-skill-docs.md`, the reading, writing, upkeep and curation workflow for file-based memory) into the Claude and `.agents` skill directories at startup.
Quest Journey phases are guided by the canonical phase briefs in `~/.companion/quest-journey-phases/<phase-id>/`, not by globally installed phase skills. Historical and canonical phase skill slugs remain internal Quest Journey compatibility metadata only; they are not installed as worker-visible skills.

## Development Commands

```bash
# Install web dependencies once before the first local dev run,
# and rerun after pulling dependency changes
bun install --cwd web --frozen-lockfile

# Dev server (Hono backend on :3456 + Vite HMR on :5174)
make dev

# Shared resource coordination
# Before starting or using shared dev servers, Agent Browser, or E2E/browser workflows,
# inspect current lease state, then acquire the relevant Takode lease before use:
takode lease status dev-server:companion
takode lease acquire dev-server:companion --purpose "Run local UI verification" --ttl 30m
takode lease renew dev-server:companion
takode lease release dev-server:companion

# Direct web runner
cd web && bun --no-install run dev

# Type checking
cd web && bun --no-install run typecheck

# Production build + serve
cd web && bun --no-install run build && bun --no-install run start

# Offline injected system prompt inspection, no live server required
cd web && bun --no-install -e 'import { buildInjectedSystemPromptForDebug } from "./server/cli-launcher-instructions.ts"; console.log(buildInjectedSystemPromptForDebug({ sessionNum: 1, backend: "claude", isOrchestrator: true }))'
```

## Dependency and Install Policy

- Active package manifests pin the package manager with `packageManager: "bun@1.3.10"` and exact-pin direct dependencies/devDependencies.
- Routine setup uses frozen installs: `bun install --cwd web --frozen-lockfile`. Use `bun install --frozen-lockfile` at the repo root only when root developer hooks are needed.
- Dependency changes must review manifest and lockfile diffs together. Avoid plain `bun install` for routine work because it may refresh lockfiles or float direct ranges.
- Before trusting lifecycle scripts introduced by dependency changes, run `bun pm untrusted` and review the package. Use focused trust decisions.
- For dependency additions/updates, default to a 3-day minimum release age: `--minimum-release-age=259200`. Override only for urgent security fixes or extension/tooling compatibility, and document why.
- Install through the machine's configured registry (for example a company npm proxy); never bypass it to get a release it does not offer yet. When a wanted version is too new for that registry, use the newest version it offers if that works, record why, and keep `bun.lock` registry-neutral. See [Configured Registries and Proxies](docs/dependency-policy.md#configured-registries-and-proxies).
- Helper scripts should fail fast when dependencies are missing. Any convenience install path must be explicitly opted in with `TAKODE_AUTO_INSTALL=1` and must use `--frozen-lockfile`. The exception is a production Restart Server, which runs a frozen install after updating its checkout unless "Update the checkout before restarting" is turned off in Settings.
- `@vscode/vsce` is trusted VS Code extension packaging tooling scoped to `vscode/takode-panel-prototype/`; keep it exact-pinned there, invoked through the local binary, and out of `web`/server runtime dependencies.

See [Dependency and Install Policy](docs/dependency-policy.md) for the contributor-facing version.

## Codex Shell PATH Note

- In Codex tool calls, prefer a non-login shell (`login: false`) for command execution. In this environment, login shells can drop `~/.bun/bin` and `~/.nvm/.../bin` from `PATH`.
- Before running tests/builds, verify runtime availability with `command -v bun && bun --version` (and optionally `command -v node && node -v`).
- If PATH is still wrong, use absolute binaries as a fallback:
  - `/home/jiayiwei/.bun/bin/bun`
  - `/home/jiayiwei/.nvm/versions/node/v22.21.1/bin/node`

## Testing

```bash
# Run tests
cd web && bun --no-install run test

# Watch mode
cd web && bun --no-install run test:watch

# Current lint/format-equivalent gate
cd web && bun --no-install run format:check
```

- All new backend (`web/server/`) and frontend (`web/src/`) code **must** include tests when possible.
- Do not add unit tests solely to lock down static instruction wording, including copied sentences, keyword checklists, or prompt snapshots. Test instruction assembly, selection, delivery, and machine-interpreted syntax; wording-specific assertions require a concrete regression rationale. Wording-only changes may rely on meaningful existing coverage and careful review instead of a new test.
- Tests use Vitest. Server tests live alongside source files (e.g. `routes.test.ts` next to `routes.ts`).
- Keep path-dependent tests portable: derive host-dependent expectations from the runtime environment or a controlled fixture root instead of hardcoding a developer's home or checkout path. Fixed synthetic paths are valid test data. Keep test writes and cleanup under isolated temporary roots, never real home or durable user-data directories.
- A husky pre-commit hook runs staged formatting, the staged file line-limit guard, and typecheck automatically before each commit. It does not run the full test suite. A commit-msg hook rejects AI attribution lines (`Co-Authored-By: Claude`, `Generated with Claude Code` and the like). Both run only in a clone where the root `bun install --frozen-lockfile` has set Git's hooks path. Husky sets the relative `.husky/_`, which worktrees cannot resolve, so a clone with worktrees needs `git config core.hooksPath <main checkout>/.husky/_`; worktrees then run the main checkout's hook scripts.
- For tracked code/test changes, the current full automated gate before merge, Port push, or final acceptance is:
  - `cd web && bun --no-install run typecheck`
  - `cd web && bun --no-install run test`
  - `cd web && bun --no-install run format:check`
- A shared remote branch opts into the landing queue by having this gate saved for it on the Takode server (`takode land gate show` prints it; `takode land gate --help` covers trying and saving one); nothing in the repository declares it. Worktree sessions landing on such a branch check their change before submitting with `takode land test` through `/port-changes`: typecheck and format whole, plus only the tests they choose as relevant to the change (`--no-tests` when none apply, `--full` for the whole gate when the change could break tests anywhere). The landing queue then runs the full gate on each batch of waiting changes before pushing (it skips that run only for a lone change whose `--full` run tested exactly that tree). Both use the rerun-and-compare rule: failing test files rerun once, and failures that also happen on the base commit are reported but don't block. Other targets run the full gate once per delivery at the classic `/port-changes` gate. While working, run focused tests for the code you change instead of the full suite. A full test run takes about 1,000 CPU-seconds, and several agents often run at once, so `takode land test --full` takes a slot of the per-machine `full-suite:takode` lease pool (leaders size it with `takode lease configure full-suite:takode@<machine> --capacity N`); landing runs don't use that pool, so worker test runs can't delay a landing.
- `format:check` is the current lint/format-equivalent gate in this repo; there is no separate `lint` script right now.
- If a full run is infeasible, document the exception explicitly in your quest summary, review handoff, or other acceptance notes before asking for merge or final acceptance.
- **Never weaken, skip or delete a test just to make a failing check pass.** Fix the code or the test. Deleting and refactoring tests is otherwise a normal part of development, such as dropping tests for retired behavior: name each removed test and why in your Work note. The leader judges whether the removal was expected and asks the user only when it was not.
- When creating test, make sure to document what the test is validating, and any important context or edge cases in comments within the test code.
- For chat feed, thread-window, notification, or selected-thread rendering changes, apply the [Feed and Thread Debugging Guardrails](docs/feed-thread-debugging.md). In particular, manual render/model loops must have an explicit progress invariant, and tests should use producer-shaped thread/window payloads instead of frontend-invented shapes.

## File Size Guardrail

- Files must stay at or under 2000 lines.
- If a change would push a file over 2000 lines, split the file before committing instead of extending it further.
- Do not try to satisfy the file-size limit with superficial line-count tricks such as collapsing formatting, removing useful whitespace/comments, or otherwise making the file harder to read. When a file is over the limit, reduce it with a real refactor or extraction that improves structure.
- The pre-commit limit is enforced against staged file contents only, so exactly 2000 lines is allowed and anything over 2000 lines fails the commit.
- Not every commit runs that hook, so the test suite also checks every tracked file (`web/scripts/tracked-file-line-limit.test.ts`). The landing gate and CI therefore reject a change, or a combination of landed changes, that leaves any file over 2000 lines, naming the file.

## Verification

- After implementing changes, verify them end-to-end when possible. For CLI tools, run the command in your worktree. For scripts, execute them. For logic changes, write a test that exercises the actual code path.
- When end-to-end verification requires a shared resource (running dev server, UI), document what should be manually verified post-deploy in the quest's verification items.
- Paid OpenAI calls made for tests and experiments (probe scripts, model comparisons, replays outside the live UI) use the user's test key, never the live server's key: pass it inline as `OPENAI_API_KEY="$(takode openai-test-key)"` so it stays out of the transcript. Never read keys from the server's settings files. When the command reports no test key, ask the user to add one in Settings > Voice > Test Key for Agents. Validation servers get the test key automatically.

## Component Playground

All UI components used in the message/chat flow **must** be represented in the Playground page (`web/src/components/Playground.tsx`, accessible at `#/playground`). When adding or modifying a message-related component (e.g. `MessageBubble`, `ToolBlock`, `PermissionBanner`, `Composer`, streaming indicators, tool groups, subagent groups), update the Playground to include a mock of the new or changed state.

## Architecture

### Data Flow

```
Browser (React) ←→ WebSocket ←→ Hono Server (Bun) ←→ Agent SDK (stdio)  ←→ Claude Code CLI
     :5174              /ws/browser/:id        :3456   ←→ JSON-RPC (stdio) ←→ codex app-server
```

1. Browser sends a "create session" REST call to the server
2. Server starts the backend: Claude Code through the Agent SDK (`claude-sdk-adapter.ts`), or `codex app-server` (`codex-adapter.ts`)
3. The adapter normalizes backend output into the bridge's common event format
4. Server bridges messages between the backend adapter and browser WebSockets
5. Tool calls arrive as permission requests (the SDK's `canUseTool` callback for Claude) — browser renders approval UI, server answers through the adapter

Claude's former native `--sdk-url` WebSocket backend is retired; see [Claude backend](docs/claude-backend.md) for the versioned compatibility findings.

### All code lives under `web/`

- **`web/server/`** — Hono + Bun backend (runs on port 3456)

  **Core runtime:**
  - `index.ts` — Server bootstrap, Bun.serve with browser and terminal WebSocket upgrades
  - `ws-bridge.ts` — Session-level state machine and WebSocket message router. Orchestrates bridge subsystems, broadcasts canonical session updates.
  - `bridge/` — Extracted bridge controllers (see details below). Each handles a focused concern (permissions, lifecycle, transport, recovery) and operates on narrow interfaces rather than full bridge state.
  - `service.ts` — Shared service container wiring server-wide dependencies.

  **CLI launchers** (split by backend and concern):
  - `cli-launcher.ts` — Core process lifecycle: launch, kill, relaunch Claude (via the SDK adapter) and Codex. Resumes the backend session ID for recovery.
  - `cli-launcher-codex.ts` — Codex-specific process lifecycle and spawn logic.
  - `cli-launcher-instructions.ts` — Generates per-session CLAUDE.md / system instructions injected at launch.
  - `cli-launcher-worktree.ts` — Worktree setup: guardrails injection, git exclude, settings symlinks (all async).

  **Backend adapters:**
  - `claude-sdk-adapter.ts` / `codex-adapter.ts` — Protocol adapters (Claude Agent SDK and Codex JSON-RPC) normalized into the bridge's common event format.
  - `codex-adapter-utils.ts` — Shared Codex adapter helpers.
  - `codex-jsonrpc-transport.ts` — Low-level JSON-RPC transport for Codex connections.
  - `codex-approval-manager.ts` — Codex-specific permission approval handling.
  - `codex-item-event-manager.ts` — Codex item-level event tracking.
  - `codex-mcp-manager.ts` — MCP server lifecycle for Codex sessions.

  **Session state:**
  - `session-store.ts` — JSON file persistence to `~/.companion/sessions/`. Debounced async writes.
  - `session-types.ts` — All TypeScript types for CLI messages, browser messages, session state, permissions.
  - `session-names.ts` / `session-namer.ts` / `session-namer-arbitration.ts` — Auto-naming pipeline with conflict arbitration.
  - `session-tag.ts` — Session tagging (leader/worker/reviewer roles, custom labels).
  - `session-search.ts` — Full-text session search across messages and metadata.
  - `session-payload-metrics.ts` — Token and payload size tracking per session.

  **Settings:**
  - `settings-manager.ts` — Manages `settings.json` with chained async writes.

  **Routes:**
  - `routes.ts` — Thin API entrypoint that mounts domain route modules from `routes/`.
  - `routes/` — Domain-specific REST modules: `sessions`, `sessions-archive-routes`, `quests`, `settings`, `filesystem`, `git`, `takode`, `recordings`, `system`, `transcription`, `context`, `logs`, `timers`, plus shared helpers (`auth`, `sessions-helpers`, `quest-helpers`).

  **Questmaster:**
  - `quest-store.ts` / `quest-types.ts` / `quest-integration.ts` / `quest-list-filters.ts` / `quest-grep.ts` — Quest persistence, lifecycle integration, filtering, and search.

  **Orchestration & herd:**
  - `takode-integration.ts` / `takode-messages.ts` — Takode orchestration integration and event/message handling.
  - `herd-event-dispatcher.ts` / `herd-change-handler.ts` / `herd-activity-formatter.ts` — Cross-session herd event dispatch and formatting.

  **Cron & timers:**
  - `cron-scheduler.ts` / `cron-store.ts` / `cron-types.ts` — Cron job scheduling and persistence.
  - `timer-manager.ts` / `timer-store.ts` / `timer-types.ts` / `timer-parse.ts` — Session-scoped timer system.

  **Recording & transcription:**
  - `recorder.ts` / `replay.ts` / `recording-traffic-report.ts` — Protocol recording, replay utilities, and traffic analysis.
  - `transcription.ts` / `transcription-enhancer.ts` — Speech-to-text and transcript post-processing.

  **Infrastructure:**
  - `idle-manager.ts` — Idle-time monitoring and automatic session cleanup.
  - `relaunch-queue.ts` — Queued relaunch coordination to prevent concurrent relaunches.
  - `container-manager.ts` — Optional containerized session runtime.
  - `env-manager.ts` — CRUD for environment profiles stored in `~/.companion/envs/`.
  - `git-utils.ts` / `github-pr.ts` / `pr-poller.ts` / `worktree-tracker.ts` — Git operations, GitHub PR integration, worktree lifecycle tracking.
  - `server-logger.ts` — Buffered async logging with periodic flush.
  - `perf-tracer.ts` — Lightweight performance tracing utilities.
  - `pushover.ts` — Push notification delivery.
  - `traffic-stats.ts` / `usage-limits.ts` — Traffic analytics and usage limit enforcement.
  - `sleep-inhibitor.ts` — Prevents OS sleep during active sessions.
  - `ripgrep.ts` / `fs-search.ts` — Server-side file search via ripgrep.
  - `migration.ts` — Data migration utilities for session/settings schema changes.
  - `skill-symlink.ts` — Links Takode's global skills into the global skill directories at startup and removes global links to project-only repo skills.

  **Bridge controllers** (`bridge/` -- extracted from `ws-bridge.ts`):

  *Transport:*
  - `browser-transport-controller.ts` — Browser WebSocket transport, history sync hashing, session tagging.
  - `adapter-browser-routing-controller.ts` — Routes browser messages to the active backend adapter (with permission-pipeline handling).
  - `adapter-interface.ts` — Shared `AdapterSessionMeta` interface and base adapter contract.

  *Permissions:*
  - `permission-pipeline.ts` — Permission request normalization, hard denies, mode-based auto-approve, human-review fallback.
  - `permission-response-controller.ts` — Handles permission responses from browser back to backend.
  - `permission-summaries.ts` — Formats permission request summaries (including Codex image drafts).

  *Lifecycle & state:*
  - `generation-lifecycle.ts` — Turn lifecycle state machine: running/idle transitions, interruption, turn event emission.
  - `session-registry-controller.ts` — In-memory registry of active sessions.
  - `session-git-state.ts` — Reads git state (branch, status) for a session's worktree.
  - `context-usage.ts` — Context window token usage tracking.
  - `branch-session-index.ts` — Indexes sessions by git branch for fast lookup.
  - `board-watchdog-controller.ts` — Watches for stuck/stalled sessions and triggers recovery.

  *Message processing:*
  - `claude-message-controller.ts` — Processes Claude CLI messages into session events.
  - `result-message-controller.ts` — Processes and emits final result messages for a turn.
  - `system-message-controller.ts` — Handles system-level messages (init, reconnect signals).
  - `quest-detector.ts` — Detects quest lifecycle signals in session output.

  *Codex-specific:*
  - `codex-adapter-browser-message-controller.ts` — Routes browser messages to the Codex adapter.
  - `codex-recovery-orchestrator.ts` — Resume/recovery snapshots for Codex turns after failures.
  - `codex-turn-queue.ts` — Queues and drains Codex turns across reconnects.
  - `claude-sdk-adapter-lifecycle-controller.ts` — Lifecycle management for the Claude SDK adapter.

  *Recovery:*
  - `compaction-recovery.ts` — Recovery after context compaction events.
  - `tool-result-recovery-controller.ts` — Recovers stuck tool-result state across reconnects.

- **`web/src/`** — React 19 frontend
  - `store.ts` — Zustand store. All state keyed by session ID (messages, generation stats, permissions, tasks, connection status).
  - `store-types.ts` / `store-initial.ts` / `store-equality.ts` — Store type definitions, initial state factories, and equality comparators.
  - `store-session-search.ts` — Full-text session search state and logic.
  - `ws-transport.ts` / `ws-handlers.ts` / `ws.ts` — Browser WebSocket transport + message handlers, with `ws.ts` as compatibility facade.
  - `terminal-ws.ts` — WebSocket transport for terminal/shell sessions.
  - `types.ts` — Re-exports server types + client-only types (`ChatMessage`, `TaskItem`, `SdkSessionInfo`).
  - `api.ts` — REST client for session management.
  - `App.tsx` — Root layout with sidebar, chat view, task panel. Hash routing (`#/playground`).
  - `hooks/` — Custom React hooks (WebSocket subscriptions, session state selectors, UI behavior).
  - `utils/` — Shared utilities (`scoped-storage.ts` for server-scoped localStorage, formatting, etc.).
  - `components/` — UI: `ChatView`, `MessageFeed`, `MessageBubble`, `ToolBlock`, `Composer`, `Sidebar`, `TopBar`, `TaskPanel`, `PermissionBanner`, `EnvManager`, `SessionCreationView`, `QuestmasterPage`, `CronManager`, `Playground`.

- **`web/bin/cli.ts`** — Main CLI entry point (currently invoked as `bunx the-companion`). Sets `__COMPANION_PACKAGE_ROOT` and imports the server.

### WebSocket Protocol

Claude Code messages arrive through the Agent SDK as stream-json objects, while Codex uses JSON-RPC through `codex-adapter.ts`; both are normalized by the bridge. Common message categories include `system` (init/status), `assistant`, `result`, `stream_event`, permission requests, tool progress/summary updates, and `keep_alive`.

`WEBSOCKET_PROTOCOL_REVERSED.md` documents the retired native WebSocket transport and remains a historical reference for the message shapes.

### Session Lifecycle

Sessions persist to disk (`~/.companion/sessions/`) and survive server restarts. Backend processes cannot reattach to a new server: Claude SDK sessions are relaunched on demand, and live Codex processes found by PID are given a grace period before being killed and relaunched. Relaunches resume the backend's own session ID. Sessions whose process runs under a `takode node` are the exception: the node keeps their processes running, and the restarted server takes each one over by its saved process id when the node reconnects (`HostLinkManager.adopt`), so their turns and pending permission requests continue. A process started with other injected instructions than the restarted server builds is ended instead, and its session starts afresh on its next message, so new instructions reach every active session; Claude sessions launch with `systemPrompt.snapshot: false`, because Claude Code otherwise keeps a conversation's first system prompt across relaunches until compaction. Skill text a conversation already holds is not refreshed that way: each start records which of Takode's own skills changed, and the first ordinary input a session then gets names the ones it had loaded before they changed, with a diff against the version it saw when the change is small and the change's size otherwise (`server/skill-change-notice.ts`). When Restart Server brings new code, each auto-updating node (this machine's included) is then updated right away so every session runs the new build: its turns are interrupted and continued once the node is back (`remote-host/host-update-sessions.ts`); other starts update a node only once its sessions are idle. Only a restart keeps them: a deliberate stop (`SIGTERM`/`SIGINT`) stops them first (`stopSessions` in `server-shutdown.ts`). That covers sessions on registered remote hosts and this machine's own sessions, which run under a node the server starts and supervises (`remote-host/local-node.ts`). Sessions saved by the retired Claude WebSocket backend load as Claude SDK sessions.

### Raw Protocol Recordings

Raw protocol recording is an explicit debugging opt-in. Normal startup does not record Claude Code NDJSON, Codex JSON-RPC, or browser transport payloads. To temporarily capture every session, start or restart Takode with exactly `COMPANION_RECORD=1` or `COMPANION_RECORD=true`; unset, `0`, `false`, and all other values keep automatic capture off. Automatic capture can consume substantial memory and disk when many sessions receive large global payloads, so enable it only while collecting a bounded diagnostic.

- **Location**: `$TMPDIR/companion-recordings/` by default (fast local tmpfs). Override with `COMPANION_RECORDINGS_DIR` for persistent storage (e.g. `~/.companion/recordings/`).
- **Format**: JSONL — one JSON object per line. First line is a header with session metadata, subsequent lines are raw message entries.
- **File naming**: `{sessionId}_{backendType}_{ISO-timestamp}_{randomSuffix}.jsonl`
- **Automatic opt-in**: set exactly `COMPANION_RECORD=1` or `COMPANION_RECORD=true` before server startup
- **Manual capture**: use the per-session REST start/stop endpoints below; manual capture is process-local, affects only that session, and does not survive restart
- **Existing files**: listing and status remain available while automatic capture is off; disabling capture does not delete or migrate files
- **Rotation**: when automatic capture is enabled, cleanup runs when total lines exceed 500k (configurable via `COMPANION_RECORDINGS_MAX_LINES`)

Each entry captures:
```json
{"ts": 1771153996875, "dir": "in", "raw": "{\"type\":\"system\",...}", "ch": "cli"}
```
- `dir`: `"in"` (received by server) or `"out"` (sent by server)
- `ch`: `"cli"` (Claude Code / Codex process) or `"browser"` (frontend WebSocket)
- `raw`: the exact original string — never re-serialized, preserving the true protocol payload

**REST API**:
- `GET /api/recordings` — list all recording files with metadata
- `GET /api/sessions/:id/recording/status` — check if a session is recording + file path
- `POST /api/sessions/:id/recording/start` / `stop` — enable/disable per session

To return to the safe default after temporary automatic capture, remove `COMPANION_RECORD` (or set it to `0`/`false`) and restart Takode. Recordings are debugging artifacts and production session behavior must not depend on them.

**Code**: `web/server/recorder.ts` (recorder + manager), `web/server/replay.ts` (load & filter utilities).

## Fork Policy: Takode + Worktrees

Takode was originally forked from [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion), but it has since heavily diverged in architecture and features.

Git worktrees are the preferred isolation model for this project. Container support remains available for compatibility, but new workflow guidance should continue to prioritize worktree-based development.

For Takode repository push, publish, and remote-branch operations, use the user's personal GitHub account rather than the default work GitHub account. Keep this scoped to Takode: other repositories should continue using the default work GitHub account unless their own repo instructions say otherwise. Do not record or expose credential contents, private key paths, tokens, or repo-local Git config values when applying this policy.

## Key Architectural Principles
(please keep these updated as you work on the codebase)

- **Takode-managed Codex processes disable built-in memory.** The shared launch policy overrides `features.memories`, `memories.generate_memories`, and `memories.use_memories` to `false` for every role and launch/relaunch path, including existing session homes. The master feature prevents background consolidation from inheriting Takode orchestration authority; generation/recall controls alone are insufficient. Keep standalone Codex preferences, existing native memory files/databases, normal delegation and Takode's Git-tracked memory intact. The policy applies when a process launches with the updated server code; existing processes are not silently interrupted or reconfigured. Coordinate any disruptive activation explicitly, and distinguish published code, loaded settings and observed suppression.
- **Production serves an isolated frontend snapshot.** `make serve` builds Vite output into a fresh validated app-owned directory under `~/.companion/runtime/frontends`, while direct CLI, package-script, and service starts validate and copy their packaged or explicitly configured frontend source there before importing the backend. Each server receives `COMPANION_FRONTEND_ROOT` for its immutable snapshot, so worker/development builds or cleanup cannot make the live UI disappear. On a supervised restart build failure, keep serving the previous validated snapshot.
- **Backend liveness and application readiness are separate.** `/api/health` reports that the backend process/API is reachable. `/api/ready` reports whether the current production frontend root contains a usable index, local entry assets, and manifest; development mode is ready through Vite. Browser restart polling, embedded UI probes, and startup scripts that promise a usable app must use readiness rather than liveness.
- **Takode supports one compatible frontend/backend build.** Supported operation assumes the frontend bundle and backend process carry the same build identity; do not retain dual protocols or state models solely for mixed-version operation. Detect identity mismatches and offer an explicit frontend Reload instead of silently falling back or reloading while the user may be working. Restart Server must check that the backend code on disk loads with the installed dependencies, and build and validate the replacement frontend, before shutting down the current compatible pair, so a failed check or build leaves that pair available. Before that check a production server's restart brings its own checkout up to date with its upstream branch (fetch, fast-forward, frozen install), so code and dependencies landed from other checkouts load; when it cannot (local changes or commits, no tracked branch, failed fetch or install) the restart stops and says why instead of loading older code. The Settings toggle "Update the checkout before restarting" turns this off; development servers restart onto their working tree as it is (`server/server-checkout.ts`). The supervisor records an unexpected backend exit, with its stderr tail, in the server log before stopping. Keep explicit one-time persisted-state migrations when durable user data still requires them.
- **Browser login guards the application surface, not the frontend bundle.** When a login password is set, `loginGate` (`web/server/browser-login.ts`) rejects `/api`, `/ws` and `/file-preview` requests that carry neither a valid login cookie nor a valid agent session token; loopback is never trusted because tunnels and proxies deliver outside traffic from it. New routes are protected automatically; a route that must stay public or authenticates itself (like the host link) must be listed explicitly in the gate. See [Browser login](docs/browser-login.md).
- **Hosts enter through the host port, which takes only tokens.** The coordinator's second listener (main port + 1000, `COMPANION_HOST_LINK_PORT`, `remote-host/host-port.ts`) serves the host link with its host token and everything else only with a valid agent session token, whatever the login setting, so a tunnel ending on a shared host opens nothing to that machine's other users. While login is off, the main port refuses other machines' host links (this machine's own node stays there). See [Shared machines](docs/remote-hosts.md#shared-machines).
- **Server is the single source of truth for all session state.** The browser must never optimistically mutate session state (messages, permission mode, model, metrics, session name, etc.) locally. Instead, the browser sends requests to the server, and the server broadcasts authoritative state updates back to ALL connected browsers. This ensures multi-browser consistency: desktop, mobile, or any number of tabs always show the same state. The only exception is purely local UI state (scroll position, sidebar open/closed, dark mode, etc.) which is never shared across browsers. Unsent drafts are shared on purpose: composer text and comments and needs-input answers are kept by the server per session and synced to every browser (`web/src/draft-sync.ts`, `shared/session-drafts.ts`). Browsers send them after a pause in typing, the last write the server receives wins per draft, and a tab never lets another browser's change overwrite its own unsent edit; composer images sync by their server reference once uploaded, while uploads still in progress stay in their tab.
- **The server is the only writer of quest, memory and stream data.** The `quest`, `memory` and `stream` CLIs send every write to the server named by `COMPANION_PORT` (or session credentials), including memory catalog reads, which record freshness and handles. Reads also ask that server, because a CLI on a remote host has no copy of the stores; a server that answers is authoritative (its not-found or error stands), and only when no server is named or answers, on a machine that is not a remote host, do they run in the CLI process, where they must not create, migrate or index stores or settings. Agents read and edit memory notes through `memory read`, `grep`, `write` and `rm`, not with their own file tools. When no server is named or reachable, writes fail with a clear error instead of falling back to local files, so a CLI on another machine can never write a divergent copy. The one exception is the server's own Codex Quest command worker (`TAKODE_QUEST_SERVER_EXECUTION`), which the server runs itself. CLI tests that write use the real routes through `server/test-fixtures/cli-write-server-harness.ts` over a disposable HOME.
- **User instructions and skills are kept once, on the coordinator, and Takode owns their standard places on every machine.** The store is `~/.companion/user-instructions/{all,claude,codex}.md` and `~/.companion/user-skills/{all,claude,codex}/` (either may link into a Git checkout; links are followed and watched). It is delivered before each launch, on host connect and on store change to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and skill links in `~/.claude/skills` and `~/.agents/skills` (`user-content-service.ts`, `user-content-install.ts`). Never replace a different file or skill entry Takode did not write without the user's approval; identical ones need none. Back up everything Takode replaces or moves, and let Takode's own skills win a name clash. Without a store, nothing is touched. Setup and migration are done by an agent following the `takode-user-content` skill with the `takode user-content` commands; Settings only hands that job to a session the user picks. See [docs/user-instructions-and-skills.md](docs/user-instructions-and-skills.md).
- **Takode config and data live on the coordinator.** Code that runs on a host (`takode node`, host operations, the agent CLIs, landing runs) takes Takode settings and data from the coordinator, never from that machine's `~/.companion`: settings the coordinator pushes over the host link (values that differ per machine, such as each machine's Claude and Codex programs, are stored by the coordinator per host, see `machineSettingsFor`) and everything else through the API via the node's proxy. Processes a node starts for a coordinator on another machine get `TAKODE_REMOTE_HOST=1`, and CLIs there never answer from local files. Only facts of the machine stay local: where tools and checkouts live, the machine's name (`machine.json`), its own credentials and tokens, the node's command-line choices (`--claude`/`--codex` tool paths, `--auto-update` and `--allow-insecure`, which are the host owner's consent and stay theirs), and working directories such as landing-run checkouts. `server/host-local-state-guard.test.ts` inventories every way host-side code reaches `~/.companion`, with the reason; add an entry only for a genuine machine fact.
- **Server history is authoritative.** Current-build browsers receive server-authored bounded state through `history_window_sync` and `thread_window_sync`; explicit `history_sync` remains the one-shot full-history/hash-recovery path. Each authoritative window or recovery snapshot replaces the state it owns rather than merging an assumed-complete browser corpus. The server's `session.messageHistory` is the single source of truth.
- **Resume replay must be idempotent for history-backed messages.** CLI `--resume` and reconnect replay can resend historical `assistant`, `result`, `compact_marker`, and `tool_result_preview` payloads. Any server path that appends to `session.messageHistory` for replayable messages must deduplicate against existing history first; otherwise replay artifacts become permanently persisted hot-tail growth and later inflate `history_sync`/session-store costs.
- **`messageHistory` is browser-only.** The server's `session.messageHistory` array is used to compose bounded browser history/thread windows, live replay support, and explicit full-history recovery. It is never sent to the CLI. Compaction only affects the CLI's internal context — changes to `messageHistory` (like appending compact markers) don't interfere with Claude Code's session.
- **CLI protocol types can diverge from TypeScript definitions.** The CLI sometimes sends fields in unexpected formats (e.g. compaction summary as a plain `string` instead of `ContentBlock[]`). Always handle both forms defensively and update the types in `session-types.ts` to match observed behavior. Protocol recordings in `~/.companion/recordings/` are the ground truth.
- **Backend tool failures must not become session failures.** Treat model-backend tool-call or router failures from Codex or Claude Code, such as Codex `write_stdin failed`, as scoped tool-call/data-plane failures. Surface failed tool output or a scoped diagnostic, preserve raw logs for debugging, clear turn/generation state coherently, and keep pending delivery plus later user/leader input deliverable. Do not convert recognized tool failures into top-level session failures unless the backend itself is unrecoverable; if a failure may leave stale turn state or pending delivery, use it as an explicit recovery signal.
- **Network outages pause turns instead of failing them.** A model request that never reached the API (offline, DNS, refused/reset connection, timeout) must not surface as a permanent feed error or a failed herd turn. Claude turns keep running in a transient `claude_network_wait` state and resume with a hidden continuation, at most 5 per outage, after Claude's own in-turn retries (launched with `CLAUDE_CODE_MAX_RETRIES=15` unless set) give up (`bridge/claude-network-wait.ts`); Codex uses its persistent outage recovery for the `model_backend_stream_error` family. Errors with an HTTP status and configuration failures (SSL, proxy tunnel) stay visible.
- **Use `process.execPath` in tests**, not `"bun"`. Bun may not be on the default PATH (e.g. installed in `~/.bun/bin`). `process.execPath` resolves to whatever runtime is executing the tests.
- **Browser localStorage is scoped per server instance.** Each server has a stable UUID (`serverId`) in `~/.companion/settings.json`, exposed via `GET /api/settings`. The frontend caches this in `localStorage["cc-server-id"]` and uses `web/src/utils/scoped-storage.ts` to prefix all server-specific keys (sessions, selected backend, recent dirs, etc.) with `{serverId}:`. Global user preferences (dark mode, zoom, notifications, telemetry) are never prefixed. When adding new localStorage keys, use `scopedGetItem`/`scopedSetItem`/`scopedRemoveItem` for server-specific state, or raw `localStorage` for global preferences. Add new global keys to the `GLOBAL_KEYS` set in `scoped-storage.ts`.
- **Minimize localStorage for session-derived state.** localStorage should only store purely local UI preferences (dark mode, zoom, sidebar state) and session creation defaults (selected backend, recent dirs). Any state derived from session activity (attention/unread badges, pending permissions, session names) must be reset from the server on every reconnect — never trust localStorage as the source of truth for these. Treat `history_window_sync` and explicit `history_sync` as authoritative session-feed deliveries and clear the browser-derived state they replace before processing; `thread_window_sync` replaces only its selected thread cache. This prevents stale data from surviving server restarts or multi-browser usage.
- **Never use synchronous file I/O in server code.** The server may run on NFS where a single `writeFileSync` can block 100ms+, stalling all WebSocket messages and HTTP responses (causing "Server unreachable" banners). Rules:
  - **All file reads/writes** must use `node:fs/promises` (`readFile`, `writeFile`, `readdir`, `unlink`, `stat`, `access`) — never `readFileSync`, `writeFileSync`, etc.
  - **All shell commands** in request handlers must use `execAsync`/`execPromise` — never `execSync`. The only exception is server startup (before the event loop serves requests).
  - **Fire-and-forget writes** (session saves, launcher state): call the async function without `await`, add `.catch()` for error logging. Keep the caller's signature `void` for API compatibility.
  - **Chained async writes** for stateful stores: use the `_pendingWrite.then(...)` pattern so writes execute in order and `_flushForTest()` can await all writes. See `settings-manager.ts` and `session-names.ts` as canonical examples.
  - **Buffered async writes** for high-throughput logging: buffer lines in memory, flush every 200ms via async `appendFile`. See `server-logger.ts` and `recorder.ts` as canonical examples.
  - **`mkdirSync` in constructors** is the only acceptable sync fs call — it's a cold path (once at startup) and prevents race conditions with concurrent async mkdirs.
  - **`// sync-ok` escape hatch**: Sync calls on documented cold paths (startup, session creation, CLI-only code) must have a `// sync-ok: <reason>` comment on the same line. The `architecture-guards.test.ts` Vitest test scans all `web/server/` source files and fails on any unannotated sync I/O call.
  - **Git commands** must include `--no-optional-locks` to avoid NFS lock contention on `.git/index.lock`.
  - **Recordings** default to `$TMPDIR/companion-recordings/` (local tmpfs, ~37× faster than NFS). They are ephemeral debugging data — never read by production code.
  - **Session data** stays on the home directory for persistence across reboots — it is critical user data. Optimize with async writes and debouncing, not by moving to tmpfs.
- **Backend liveness follows the adapter's process.** The Claude SDK and Codex adapters own their stdio processes. When an adapter reports a disconnect or init error, the bridge cancels pending permissions, settles the turn and requests a throttled relaunch, stopping after repeated consecutive failures; idle-limit kills are not relaunched. The launcher reports a Claude session `starting` until its process spawns and `exited` when it fails to start or ends unexpectedly, keeping the saved session ID for resume, so cron, liveness checks and lists never see a dead backend as connected. `keep_alive` heartbeats are not activity, so stuck-turn detection still fires. Browser sockets get 10s `ws.ping()` heartbeats.
- **Agent visuals never run with Takode's authority and never get to hang it.** A ```visual block renders in a sandboxed, opaque-origin frame (`VisualBlock.tsx`). Chrome runs all of a page's sandboxed frames in one shared process and Safari runs them in the page's own process, so `visual-frame-supervisor.ts` loads frames one at a time, stops a visual that hangs, crashes, keeps the processor busy or slows the page, and unloads the rest to end a frozen shared process; a device then shows that visual as a server-drawn still picture with Run (`visual-stop-memory.ts`). Where frames share the page's process, a visual with scripts runs only after the server's headless Chrome (`visual-renderer.ts`, memory-capped) drew it cleanly, and only while on screen; a diagram, which looks the same either way, stays the server's drawing. Each visual keeps a script-free still picture under its live frame (`visual-still-cache.ts`), loaded well ahead of the viewport, so scrolling never shows a blank or a redraw; viewport margins are measured against the scrolling feed, since the window's margin is clipped away. Plain-text surfaces (copy, read aloud, search) use the visual's `alt:` text.
- **Browsers receive completed text, not live deltas.** `broadcastToBrowsers` drops answer and thinking `content_block_delta` stream events, so messages appear once complete, and the browser keeps no live-text state. Backends keep streaming them to the server because they count as turn activity for the stuck-turn watchdog and Codex replay safety; stream boundaries, tool progress and Codex reasoning previews still reach browsers.
  - **Worktree setup must be fully async.** Creating a new worktree session involves file I/O (guardrails injection, git exclude, settings symlinks) and git commands (`update-index --skip-worktree`). On NFS, synchronous versions of these operations can block the event loop for 10+ seconds, stalling every backend and browser connection. All worktree setup methods in `cli-launcher.ts` (`injectWorktreeGuardrails`, `addWorktreeGitExclude`, `symlinkProjectSettings`) must use async I/O.

## Browser Exploration

For Takode UI/E2E validation workflows, use the `takode-ui-e2e-validation` skill.

Before browser/E2E work, you must acquire the appropriate resource lease. Full browser validation usually needs both `dev-server:companion` and `agent-browser`; server-only work needs `dev-server:companion`; browser-only inspection of an already-authorized server needs `agent-browser`. Use `takode lease status <resource>` only to inspect current ownership before acquiring; it is not a substitute for holding the lease. If a lease command queues you, wait for the Resource Lease promotion message instead of polling. Heartbeat while using the resource and release it promptly when done.

For normal Takode E2E/browser validation, default to the authorized shared persistent validation state for the dev-server workflow when one is available. Treat that state as shared validation evidence: workers may add useful long conversations, sessions, quests, and scenarios, and should retain newly created state when it is likely to help future validation. Clean up only state that is clearly harmful, misleading, sensitive, destructive, or otherwise not useful. Use isolated temp HOME/state, Playground/browser fixtures, or sanitized copied-live snapshots only when isolation is required, such as destructive tests, privacy-sensitive data, reset-sensitive scenarios, narrow frontend-only checks, or a bug tied to a specific copied history. Always document the profile/state strategy, scenario provenance, and cleanup/retention decision in Execute or validation notes.

Always use the `agent-browser` CLI command to explore the browser.
E2E UI testing requires the real `agent-browser` program and a headless Chrome on the machine the session runs on. If either is missing, flag it to the user and offer to install it; install only with the user's approval (workers ask their leader). The `takode-ui-e2e-validation` skill has the checks and install commands.
When running E2E tests, use the dark theme, as it is the primary theme of this app.
When running E2E tests, use a viewport at least as large as a normal iPhone Pro/Max screen (for example `430x932`).

## Pull Requests

When submitting a pull request:
- use commitzen to format the commit message and the PR title
- Add a screenshot of the changes in the PR description if its a visual change
- Explain simply what the PR does and why it's needed
- Tell me if the code was reviewed by a human or simply generated directly by an AI. 

### How To Open A PR With GitHub CLI

Use this flow from the repository root:

```bash
# 1) Create a branch
git checkout -b fix/short-description (commitzen)

# 2) Commit using commitzen format
git add <files>
git commit -m "fix(scope): short summary" (commitzen)

# 3) Push and set upstream using the Takode personal-account remote policy
git push -u <personal-remote> fix/short-description

# 4) Create PR (title should follow commitzen style)
gh pr create --base main --head fix/short-description --title "fix(scope): short summary"
```

For multi-line PR descriptions, prefer a body file to avoid shell quoting issues:

```bash
cat > /tmp/pr_body.md <<'EOF'
## Summary
- what changed

## Why
- why this is needed

## Testing
- what was run

## Review provenance
- Implemented by AI agent / Human
- Human review: yes/no
EOF

gh pr edit --body-file /tmp/pr_body.md
```

## Codex & Claude Code
- All features must be compatible with both Codex and Claude Code. If a feature is only compatible with one, it must be gated behind a clear UI affordance (e.g. "This feature requires Claude Code") and the incompatible option should be hidden or disabled.
- When implementing a new feature, always consider how it will work with both models and test with both if possible. If a feature is only implemented for one model, document that clearly in the code and in the UI.

import { createContext, useContext, useEffect, useState } from "react";
import { api } from "../../api.js";
import { useStore } from "../../store.js";
import type { ChatMessage, McpServerDetail, TaskItem } from "../../types.js";
import { BoardBlock } from "../BoardBlock.js";
import { CatPawAvatar, YarnBallSpinner } from "../CatIcons.js";
import { ClaudeMdEditor } from "../ClaudeMdEditor.js";
import { FolderPicker } from "../FolderPicker.js";
import { Lightbox } from "../Lightbox.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { MessageBubble, NotificationMarker, HerdEventMessage } from "../MessageBubble.js";
import { ContextMenu, type ContextMenuItem } from "../ContextMenu.js";
import { PawTrailAvatar } from "../PawTrail.js";
import { StatusCountDots } from "../SessionItem.js";
import { CodexRateLimitsSection, CodexTokenDetailsSection, WorkspaceTokenUsageByModelView } from "../TaskPanel.js";
import { TimerModal } from "../TimerWidget.js";
import { ToolBlock, getToolIcon, getToolLabel, getPreview, ToolIcon, formatDuration } from "../ToolBlock.js";
import { PLAYGROUND_SESSION_ROWS } from "./fixtures.js";
import { getPlaygroundSectionId, type PlaygroundSectionGroupId } from "./navigation.js";
import {
  THREAD_ROUTING_REMINDER_SOURCE_ID,
  THREAD_ROUTING_REMINDER_SOURCE_LABEL,
} from "../../../shared/thread-routing-reminder.js";
import {
  QUEST_THREAD_REMINDER_SOURCE_ID,
  QUEST_THREAD_REMINDER_SOURCE_LABEL,
} from "../../../shared/quest-thread-reminder.js";
import {
  THREAD_OUTCOME_REMINDER_SOURCE_ID,
  THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
} from "../../../shared/thread-outcome-reminder.js";
import {
  COMPACTION_RECOVERY_SOURCE_ID,
  COMPACTION_RECOVERY_SOURCE_LABEL,
  LEADER_KICKOFF_SOURCE_ID,
  LEADER_KICKOFF_SOURCE_LABEL,
  MEMORY_CATALOG_SOURCE_ID,
  MEMORY_CATALOG_SOURCE_LABEL,
  MEMORY_CATALOG_TITLE,
  MEMORY_CATALOG_TRUNCATED_PREFIX,
  leaderSkillPreloadSourceId,
  leaderSkillPreloadSourceLabel,
} from "../../../shared/injected-event-message.js";

const PlaygroundSectionGroupContext = createContext<PlaygroundSectionGroupId | null>(null);
const NEEDS_INPUT_REMINDER_SOURCE = {
  sessionId: "system:needs-input-reminder",
  sessionLabel: "Needs Input Reminder",
};
const NEEDS_INPUT_RESOLUTION_SOURCE = {
  sessionId: "system:needs-input-resolution",
  sessionLabel: "Needs Input Resolution",
};

export function PlaygroundSectionGroup({
  groupId,
  children,
}: {
  groupId: PlaygroundSectionGroupId;
  children: React.ReactNode;
}) {
  return <PlaygroundSectionGroupContext.Provider value={groupId}>{children}</PlaygroundSectionGroupContext.Provider>;
}

export function PlaygroundHerdSummaryBar({ isExpanded }: { isExpanded: boolean }) {
  return (
    <div className="w-full flex items-center gap-1.5 px-3 py-1 border-t border-cc-border/30 text-[10px] text-cc-muted">
      <StatusCountDots counts={{ running: 2, permission: 1, unread: 0, waiting: 1 }} />
      <span className="flex items-center gap-0.5 text-cc-muted/50">
        1
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-cc-muted/30" />
      </span>
      <span className="ml-auto text-cc-muted/50 shrink-0">4 workers</span>
      <svg
        viewBox="0 0 16 16"
        fill="currentColor"
        className={`w-3 h-3 text-cc-muted/40 shrink-0 ${isExpanded ? "rotate-180" : ""}`}
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </div>
  );
}

export function PlaygroundBoardWithOriginalCommand() {
  useEffect(() => {
    const sessionResults = new Map();
    const resultContent = [
      JSON.stringify(
        {
          __takode_board__: true,
          board: [{ questId: "q-412", title: "Debug board command output", updatedAt: Date.now() - 15000 }],
          operation: "set q-412",
        },
        null,
        2,
      ),
      "",
      "Quest   Title                     Worker  State",
      "q-412   Debug board command output  --      Planning",
    ].join("\n");
    sessionResults.set("playground-board-original", {
      content: resultContent,
      is_error: false,
      is_truncated: false,
      total_size: resultContent.length,
    });
    const toolResults = new Map(useStore.getState().toolResults);
    toolResults.set("playground-board-original-session", sessionResults);
    useStore.setState({ toolResults });

    return () => {
      const nextToolResults = new Map(useStore.getState().toolResults);
      nextToolResults.delete("playground-board-original-session");
      useStore.setState({ toolResults: nextToolResults });
    };
  }, []);

  return (
    <BoardBlock
      board={[{ questId: "q-412", title: "Debug board command output", updatedAt: Date.now() - 15000 }]}
      operation="set q-412"
      toolUseId="playground-board-original"
      sessionId="playground-board-original-session"
      originalToolName="Bash"
      originalInput={{ command: "takode board show --json" }}
      originalCommand="takode board show --json"
      defaultOpen
      defaultShowOriginalCommand
    />
  );
}

export function PlaygroundCollapsedBoardCommand() {
  return (
    <BoardBlock
      board={[
        {
          questId: "q-1429",
          title: "Make workboard tool calls collapse like terminal commands",
          status: "WORKING",
          updatedAt: Date.now() - 30000,
        },
      ]}
      operation="advance q-1429"
      toolUseId="playground-board-collapsed-command"
      sessionId="playground-board-collapsed-command-session"
      originalToolName="Bash"
      originalInput={{ command: "takode board advance q-1429" }}
      originalCommand="takode board advance q-1429"
    />
  );
}

export function PlaygroundCompletedViewImageTool() {
  useEffect(() => {
    const toolResults = new Map(useStore.getState().toolResults);
    const sessionResults = new Map(toolResults.get("playground-view-image-session") || []);
    sessionResults.set("tb-view-image", {
      tool_use_id: "tb-view-image",
      content: "/Users/stan/Dev/project/docs/bug-screenshot.png",
      is_error: false,
      is_truncated: false,
      total_size: 41,
      duration_seconds: 0.4,
    });
    toolResults.set("playground-view-image-session", sessionResults);
    useStore.setState({ toolResults });

    return () => {
      const nextToolResults = new Map(useStore.getState().toolResults);
      nextToolResults.delete("playground-view-image-session");
      useStore.setState({ toolResults: nextToolResults });
    };
  }, []);

  return (
    <ToolBlock
      name="view_image"
      input={{ path: "/Users/stan/Dev/project/docs/bug-screenshot.png" }}
      toolUseId="tb-view-image"
      sessionId="playground-view-image-session"
    />
  );
}

export function PlaygroundFolderPicker() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 text-xs font-medium rounded-md bg-cc-primary text-white hover:bg-cc-primary/90 transition-colors cursor-pointer"
      >
        Open Folder Picker
      </button>
      {selected && <p className="text-xs text-cc-muted font-mono-code">Selected: {selected}</p>}
      {open && (
        <FolderPicker
          initialPath={selected || ""}
          onSelect={(path) => setSelected(path)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const groupId = useContext(PlaygroundSectionGroupContext);
  const sectionId = groupId ? getPlaygroundSectionId(groupId, title) : undefined;

  return (
    <section id={sectionId} data-playground-section-id={sectionId} className="scroll-mt-28">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-cc-fg">{title}</h2>
        <p className="text-xs text-cc-muted mt-0.5">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-cc-border rounded-xl overflow-hidden bg-cc-card">
      <div className="px-3 py-1.5 bg-cc-hover/50 border-b border-cc-border">
        <span className="text-[10px] text-cc-muted font-mono-code uppercase tracking-wider">{label}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Inline Tool Group (mirrors MessageFeed's ToolMessageGroup) ─────────────

export interface ToolItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface DelegateTraceItem {
  kind: "assistant" | "tool";
  label: string;
  text?: string;
  status?: "running" | "completed" | "failed";
  isError?: boolean;
  isTruncated?: boolean;
}

export function PlaygroundToolGroup({ toolName, items }: { toolName: string; items: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(toolName);
  const label = getToolLabel(toolName);
  const count = items.length;

  if (count === 1) {
    const item = items[0];
    return (
      <div className="flex items-start gap-3">
        <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <CatPawAvatar className="w-3 h-3 text-cc-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
            <button
              onClick={() => setOpen(!open)}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              <ToolIcon type={iconType} />
              <span className="text-xs font-medium text-cc-fg">{label}</span>
              <span className="text-xs text-cc-muted truncate flex-1 font-mono-code">
                {getPreview(item.name, item.input)}
              </span>
            </button>
            {open && (
              <div className="px-3 pb-3 pt-0 border-t border-cc-border mt-0">
                <pre className="mt-2 text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
                  {JSON.stringify(item.input, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3">
      <div className="w-6 h-6 rounded-full bg-cc-primary/10 flex items-center justify-center shrink-0 mt-0.5">
        <CatPawAvatar className="w-3 h-3 text-cc-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <ToolIcon type={iconType} />
            <span className="text-xs font-medium text-cc-fg">{label}</span>
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums font-medium">
              {count}
            </span>
          </button>
          {open && (
            <div className="border-t border-cc-border px-3 py-1.5">
              {items.map((item, i) => {
                const preview = getPreview(item.name, item.input);
                return (
                  <div
                    key={item.id || i}
                    className="flex items-center gap-2 py-1 text-xs text-cc-muted font-mono-code truncate"
                  >
                    <span className="w-1 h-1 rounded-full bg-cc-muted/40 shrink-0" />
                    <span className="truncate">{preview || JSON.stringify(item.input).slice(0, 80)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inline Subagent Group (mirrors MessageFeed's SubagentContainer) ────────

export function PlaygroundSubagentGroup({
  description,
  agentType,
  items,
  delegateTrace,
  delegatePendingState,
  rawDelegateLabel,
  resultText,
  prompt,
  commandPreview,
  durationSeconds,
  liveStartedAt,
  interrupted,
}: {
  description: string;
  agentType: string;
  items: ToolItem[];
  delegateTrace?: DelegateTraceItem[];
  delegatePendingState?: "waiting" | "stopped";
  rawDelegateLabel?: string;
  resultText?: string;
  prompt?: string;
  commandPreview?: string;
  durationSeconds?: number;
  liveStartedAt?: number;
  interrupted?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [promptOpen, setPromptOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [liveSeconds, setLiveSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (!liveStartedAt || durationSeconds != null) {
      setLiveSeconds(null);
      return;
    }
    const tick = () => {
      setLiveSeconds(Math.max(0, Math.round((Date.now() - liveStartedAt) / 1000)));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [liveStartedAt, durationSeconds]);

  const displayDurationSeconds = durationSeconds ?? liveSeconds;
  const isDelegateTask = agentType === "delegate_task";
  const isLegacyDelegateCommand = agentType === "delegate_command";
  const isDelegate = isDelegateTask || isLegacyDelegateCommand;
  const delegatePreview = commandPreview || (isDelegate ? prompt : "");
  const bashItem = items.find((item) => item.name === "Bash");
  const remainingDelegateItems = isDelegateTask ? items.filter((item) => item !== bashItem) : items;
  const delegateResultSummary = isDelegate
    ? resultText?.match(/(?:^|\n)Summary:\s*\n?([\s\S]*?)(?=\n\nInspect:|$)/i)?.[1]?.trim()
    : null;
  const activityCount = items.length + (delegateTrace?.length ?? 0) + (delegatePendingState ? 1 : 0);

  return (
    <div className="flex items-start gap-3">
      <PawTrailAvatar />
      <div className="flex-1 min-w-0">
        <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          {/* Header */}
          <button
            onClick={() => setOpen(!open)}
            className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className={`w-3 h-3 text-cc-muted transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            <ToolIcon type={isLegacyDelegateCommand ? "terminal" : "agent"} />
            <span className="text-xs font-medium text-cc-fg truncate">{description}</span>
            {isDelegate && delegatePreview && (
              <span
                className="min-w-0 flex-1 truncate rounded-md bg-cc-code-bg/70 px-2 py-1 font-mono-code text-[11px] text-cc-code-fg"
                title={delegatePreview}
              >
                {delegatePreview}
              </span>
            )}
            {agentType && !isDelegate && (
              <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 shrink-0">
                {agentType}
              </span>
            )}
            {!open && resultText && (
              <span className="text-[11px] text-cc-muted truncate ml-1 font-mono-code">
                {resultText.length > 120 ? resultText.slice(0, 120) + "..." : resultText}
              </span>
            )}
            {displayDurationSeconds != null && (
              <span
                className={`text-[10px] tabular-nums shrink-0 ${durationSeconds != null ? "text-cc-muted" : "text-cc-primary"}`}
              >
                {formatDuration(displayDurationSeconds)}
              </span>
            )}
            <span className="text-[10px] text-cc-muted bg-cc-hover rounded-full px-1.5 py-0.5 tabular-nums shrink-0 ml-auto">
              {activityCount > 0 ? activityCount : interrupted ? "—" : "0"}
            </span>
          </button>

          {/* Expanded content */}
          {open && (
            <div className="border-t border-cc-border">
              {/* Collapsible prompt section */}
              {prompt && (
                <div className="border-b border-cc-border/50">
                  <button
                    onClick={() => setPromptOpen(!promptOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${promptOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Prompt</span>
                  </button>
                  {promptOpen && (
                    <div className="px-3 pb-2">
                      <pre className="text-[11px] text-cc-muted font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                        {prompt}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* Child activities */}
              {activityCount > 0 && (
                <div className="border-b border-cc-border/50">
                  <button
                    onClick={() => setActivitiesOpen(!activitiesOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${activitiesOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Activities</span>
                  </button>
                  {activitiesOpen && (
                    <div className="px-3 pb-2 space-y-3">
                      {delegatePendingState === "waiting" && (
                        <div className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2 text-[11px] text-cc-muted">
                          Waiting for delegate handoff through end_delegation. No delegate activity has been recorded
                          yet.
                        </div>
                      )}
                      {delegatePendingState === "stopped" && (
                        <div className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2 text-[11px] text-cc-muted">
                          Delegate child is stopped or idle without an end_delegation handoff. Takode is keeping the
                          trace inspectable while the parent waits for the bounded no-handoff path.
                        </div>
                      )}
                      {delegateTrace?.map((event, index) => (
                        <div
                          key={event.label + "-" + index}
                          className="rounded-[8px] border border-cc-border/50 bg-cc-hover/20 px-3 py-2"
                        >
                          <div className="flex items-center gap-2 text-[11px] text-cc-muted">
                            <ToolIcon type={event.kind === "tool" ? "terminal" : "agent"} />
                            <span className="font-medium">{event.label}</span>
                            {event.status && (
                              <span className={event.isError ? "text-cc-error" : "text-cc-muted/80"}>
                                {event.status}
                              </span>
                            )}
                            {event.isTruncated && <span className="text-cc-muted/70">truncated</span>}
                          </div>
                          {event.text && (
                            <pre className="mt-1 whitespace-pre-wrap break-words font-mono-code text-[11px] leading-relaxed text-cc-fg/90">
                              {event.text}
                            </pre>
                          )}
                        </div>
                      ))}
                      {isDelegateTask && bashItem ? (
                        <>
                          <div className="overflow-hidden rounded-[10px] border border-cc-border bg-cc-card">
                            <div className="flex items-center gap-2.5 px-3 py-2">
                              <svg
                                viewBox="0 0 16 16"
                                fill="currentColor"
                                className="h-3 w-3 shrink-0 rotate-90 text-cc-muted"
                              >
                                <path d="M6 4l4 4-4 4" />
                              </svg>
                              <ToolIcon type="terminal" />
                              <span className="min-w-0 flex-1 truncate font-mono-code text-xs text-cc-fg/90">
                                {String(bashItem.input.command || "")}
                              </span>
                              <span className="shrink-0 text-[10px] text-cc-muted">completed</span>
                            </div>
                            <div className="border-t border-cc-border px-3 pb-3 pt-2">
                              <pre className="max-h-40 overflow-x-auto overflow-y-auto whitespace-pre-wrap rounded-lg bg-cc-code-bg px-2.5 py-2 font-mono-code text-[11px] leading-relaxed text-cc-muted">
                                {String(bashItem.input.result || "Read the first three sample lines.")}
                              </pre>
                            </div>
                          </div>
                          {remainingDelegateItems.length > 0 && (
                            <PlaygroundToolGroup
                              toolName={remainingDelegateItems[0]?.name || "Grep"}
                              items={remainingDelegateItems}
                            />
                          )}
                        </>
                      ) : (
                        items.length > 0 && <PlaygroundToolGroup toolName={items[0]?.name || "Grep"} items={items} />
                      )}
                      {rawDelegateLabel && (
                        <div className="text-[11px] text-cc-muted">
                          <a className="text-cc-primary hover:underline" href={"#/session/" + rawDelegateLabel}>
                            Open raw delegate transcript: {rawDelegateLabel}
                          </a>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* No children yet indicator */}
              {activityCount === 0 && !resultText && !interrupted && (
                <div className="px-3 py-2 flex items-center gap-1.5 text-[11px] text-cc-muted">
                  <YarnBallSpinner className="w-3.5 h-3.5" />
                  <span>Agent starting...</span>
                </div>
              )}

              {/* Interrupted subagent — session ended without completion */}
              {activityCount === 0 && interrupted && (
                <div className="px-3 py-2 text-[11px] text-cc-muted">Agent interrupted</div>
              )}

              {/* Result */}
              {resultText && (
                <div className="border-t border-cc-border/50">
                  <button
                    onClick={() => setResultOpen(!resultOpen)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="currentColor"
                      className={`w-2.5 h-2.5 text-cc-muted transition-transform shrink-0 ${resultOpen ? "rotate-90" : ""}`}
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="text-[11px] font-medium text-cc-muted">Result</span>
                  </button>
                  {resultOpen && (
                    <div className="px-3 pb-2">
                      <div className="text-sm max-h-96 overflow-y-auto">
                        {isDelegate && delegateResultSummary ? (
                          <>
                            <MarkdownContent text={delegateResultSummary} />
                            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-cc-border/50 pt-2 text-[11px]">
                              <dt className="text-cc-muted">Delegate</dt>
                              <dd className="min-w-0 break-words text-cc-fg/85">del_playground123</dd>
                              <dt className="text-cc-muted">{isLegacyDelegateCommand ? "Command" : "Task"}</dt>
                              <dd className="min-w-0 break-words text-cc-fg/85">{delegatePreview}</dd>
                              <dt className="text-cc-muted">Inspect</dt>
                              <dd className="min-w-0 break-words text-cc-fg/85">delegate del_playground123</dd>
                            </dl>
                          </>
                        ) : (
                          <MarkdownContent text={resultText} />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function PlaygroundDelegateTaskGroup() {
  return (
    <PlaygroundSubagentGroup
      description="Delegated task"
      agentType="delegate_task"
      commandPreview="Inspect delegate-sample.txt and summarize the first three sample lines."
      prompt="Inspect delegate-sample.txt and summarize the first three sample lines."
      items={[
        {
          id: "delegate-bash",
          name: "Bash",
          input: { command: "sed -n '1,3p' delegate-sample.txt", result: "alpha\nbeta\ngamma" },
        },
        {
          id: "delegate-end",
          name: "mcp:takode_delegate:end_delegation",
          input: { summary: "Read the first three sample lines." },
        },
      ]}
      durationSeconds={2.4}
      resultText={
        "Delegate task completed.\n\nDelegate: del_playground123\nTask: Inspect delegate-sample.txt and summarize the first three sample lines.\n\nSummary:\nRead the first three sample lines.\n\nInspect:\n- Expand the Delegate task card to inspect the delegate trace/raw-output link for delegate del_playground123."
      }
    />
  );
}

export function PlaygroundDelegateTaskPendingNoHandoffGroup() {
  return (
    <PlaygroundSubagentGroup
      description="Delegated task"
      agentType="delegate_task"
      commandPreview="Fork-memory probe. Do not use tools or inspect history; answer only from inherited context."
      prompt="Fork-memory probe. Do not use tools or inspect history; answer only from inherited context."
      items={[]}
      delegatePendingState="waiting"
      rawDelegateLabel="del_waiting123"
      liveStartedAt={Date.now() - 93_000}
    />
  );
}

export function PlaygroundDelegateTaskPendingLiveActivityGroup() {
  return (
    <PlaygroundSubagentGroup
      description="Delegated task"
      agentType="delegate_task"
      commandPreview="Fork-memory probe. Do not use tools or inspect history; answer only from inherited context."
      prompt="Fork-memory probe. Do not use tools or inspect history; answer only from inherited context."
      items={[]}
      delegatePendingState="stopped"
      rawDelegateLabel="del_live123"
      liveStartedAt={Date.now() - 183_000}
      delegateTrace={[
        {
          kind: "assistant",
          label: "Assistant",
          text: "I cannot know the exact fork-memory sentinel from inherited context. I used no tools.",
          status: "completed",
        },
      ]}
    />
  );
}

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

export function PlaygroundHerdEventDemo({ id, content }: { id: string; content: string }) {
  useEffect(() => {
    const prevSdkSessions = useStore.getState().sdkSessions;

    useStore.setState({
      sdkSessions: [
        ...prevSdkSessions.filter((session) => session.sessionId !== "worker-alpha"),
        {
          sessionId: "worker-alpha",
          sessionNum: 8,
          createdAt: 1,
          cwd: "/Users/stan/Dev/takode",
          state: "running",
          model: "gpt-5.4-mini",
          backendType: "codex",
          cliConnected: true,
          name: "Worker Alpha",
        },
      ],
    });

    return () => {
      useStore.setState({ sdkSessions: prevSdkSessions });
    };
  }, []);

  return (
    <HerdEventMessage
      showTimestamp={false}
      message={{
        id,
        role: "user",
        content,
        timestamp: Date.now(),
        agentSource: { sessionId: "herd-events", sessionLabel: "Herd Events" },
      }}
    />
  );
}

// ─── Inline ClaudeMd Button (opens the real editor modal) ───────────────────

export function PlaygroundClaudeMdButton() {
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("/tmp");

  useEffect(() => {
    api
      .getHome()
      .then((res) => setCwd(res.cwd))
      .catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-hover border border-cc-border hover:bg-cc-active transition-colors cursor-pointer"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-primary">
          <path d="M4 1.5a.5.5 0 01.5-.5h7a.5.5 0 01.354.146l2 2A.5.5 0 0114 3.5v11a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-13zm1 .5v12h8V4h-1.5a.5.5 0 01-.5-.5V2H5zm6 0v1h1l-1-1zM6.5 7a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h5a.5.5 0 000-1h-5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1h-3z" />
        </svg>
        <span className="text-xs font-medium text-cc-fg">Edit CLAUDE.md</span>
      </button>
      <span className="text-[11px] text-cc-muted">Click to open the editor modal (uses server working directory)</span>
      <ClaudeMdEditor cwd={cwd} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

export function PlaygroundReviewNotificationMarker({ summary }: { summary?: string }) {
  const [done, setDone] = useState(false);

  return (
    <NotificationMarker
      category="review"
      summary={summary}
      doneOverride={done}
      onToggleDone={() => setDone((prev) => !prev)}
      showReplyAction={false}
    />
  );
}

export function PlaygroundSuggestedAnswerNotificationMarker() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-suggested-notify", [
      {
        id: "n-suggested-1",
        category: "needs-input",
        timestamp: Date.now() - 30_000,
        messageId: "playground-suggested-notify-msg",
        summary: "Approve the rollout?",
        suggestedAnswers: [
          "Continue the rollout now; the canary looks healthy and the current error budget is acceptable.",
          "Hold the rollout until the manual smoke checks finish and the on-call engineer confirms.",
        ],
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  return (
    <NotificationMarker
      category="needs-input"
      summary="Approve the rollout?"
      sessionId="playground-suggested-notify"
      messageId="playground-suggested-notify-msg"
      notificationId="n-suggested-1"
    />
  );
}

export function PlaygroundMultiQuestionNotificationMarker() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-multi-question-notify", [
      {
        id: "n-multi-question-1",
        category: "needs-input",
        timestamp: Date.now() - 30_000,
        messageId: "playground-multi-question-notify-msg",
        summary: "Confirm launch choices",
        questions: [
          { prompt: "Which launch path?", suggestedAnswers: ["staged", "full"] },
          { prompt: "When should it start?", suggestedAnswers: ["now", "after review"] },
        ],
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  return (
    <NotificationMarker
      category="needs-input"
      summary="Confirm launch choices"
      sessionId="playground-multi-question-notify"
      messageId="playground-multi-question-notify-msg"
      notificationId="n-multi-question-1"
    />
  );
}

export function PlaygroundAddressedSuggestedAnswerNotificationMarker() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-addressed-suggested-notify", [
      {
        id: "n-addressed-suggested-1",
        category: "needs-input",
        timestamp: Date.now() - 30_000,
        messageId: "playground-addressed-suggested-notify-msg",
        summary: "Approve the rollout?",
        suggestedAnswers: [
          "Continue the rollout now; the canary looks healthy and the current error budget is acceptable.",
          "Hold the rollout until the manual smoke checks finish and the on-call engineer confirms.",
        ],
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  return (
    <NotificationMarker
      category="needs-input"
      summary="Approve the rollout?"
      sessionId="playground-addressed-suggested-notify"
      messageId="playground-addressed-suggested-notify-msg"
      notificationId="n-addressed-suggested-1"
    />
  );
}

export function PlaygroundDedupedNotificationMessage() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-dedup-notify", [
      {
        id: "playground-dedup-notif-1",
        category: "review",
        timestamp: Date.now() - 15_000,
        messageId: "playground-dedup-msg",
        done: false,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  const message: ChatMessage = {
    id: "playground-dedup-msg",
    role: "assistant",
    content: "I have the result. I'll send the notification summary and then give you the exact observed behavior.",
    timestamp: Date.now() - 15_000,
    contentBlocks: [
      {
        type: "tool_use",
        id: "playground-dedup-tool",
        name: "Bash",
        input: { command: 'TAKODE_API_PORT=3455 takode notify review "Async command experiment finished"' },
      },
    ],
    notification: {
      category: "review",
      timestamp: Date.now() - 15_000,
      summary: "Async command experiment finished",
    },
  };

  return (
    <div className="p-3">
      <p className="mb-3 text-xs text-cc-muted">
        Same-message dedupe: the authoritative notification marker stays visible, while the matching `takode notify`
        tool-use in the same assistant message does not render a second chip.
      </p>
      <MessageBubble message={message} sessionId="playground-dedup-notify" showTimestamp={false} />
    </div>
  );
}

export function PlaygroundAddressedNotifyToolBlock() {
  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set("playground-addressed-notify", [
      {
        id: "playground-addressed-notif-1",
        category: "needs-input",
        timestamp: Date.now() - 20_000,
        messageId: "playground-addressed-msg",
        summary: "Confirm scope before continuing",
        done: true,
      },
    ]);
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, []);

  return (
    <ToolBlock
      name="Bash"
      input={{ command: 'takode notify needs-input "Confirm scope before continuing"' }}
      toolUseId="playground-addressed-notify-tool"
      sessionId="playground-addressed-notify"
      parentMessageId="playground-addressed-msg"
    />
  );
}

export function PlaygroundNeedsInputReminderMessage({ variant }: { variant: "resolved" | "active" | "partial" }) {
  const sessionId = `playground-needs-input-reminder-${variant}`;
  const isPartial = variant === "partial";
  const message: ChatMessage = {
    id: `playground-needs-input-reminder-${variant}-msg`,
    role: "user",
    content: isPartial
      ? [
          "[Needs-input reminder]",
          "Unresolved same-session needs-input notifications: 4. Showing newest 3.",
          "  6. Newest pending question",
          "  5. Second newest pending question",
          "  3. Third newest pending question",
          "Review or resolve these before assuming the user's latest message answered them.",
        ].join("\n")
      : [
          "[Needs-input reminder]",
          "Unresolved same-session needs-input notifications: 1.",
          "  17. Confirm rollout scope",
          "Review or resolve these before assuming the user's latest message answered them.",
        ].join("\n"),
    timestamp: Date.now() - 30_000,
    agentSource: NEEDS_INPUT_REMINDER_SOURCE,
  };

  useEffect(() => {
    const previous = useStore.getState().sessionNotifications;
    const next = new Map(previous);
    next.set(
      sessionId,
      isPartial
        ? [
            {
              id: "n-6",
              category: "needs-input",
              timestamp: Date.now() - 60_000,
              messageId: null,
              summary: "Newest pending question",
              done: true,
            },
            {
              id: "n-5",
              category: "needs-input",
              timestamp: Date.now() - 70_000,
              messageId: null,
              summary: "Second newest pending question",
              done: true,
            },
            {
              id: "n-3",
              category: "needs-input",
              timestamp: Date.now() - 80_000,
              messageId: null,
              summary: "Third newest pending question",
              done: true,
            },
          ]
        : [
            {
              id: "n-17",
              category: "needs-input",
              timestamp: Date.now() - 45_000,
              messageId: null,
              summary: "Confirm rollout scope",
              done: variant === "resolved",
            },
          ],
    );
    useStore.setState({ sessionNotifications: next });

    return () => {
      useStore.setState({ sessionNotifications: previous });
    };
  }, [isPartial, sessionId, variant]);

  return <MessageBubble message={message} sessionId={sessionId} showTimestamp={false} />;
}

export function PlaygroundNeedsInputResolutionNoticeMessage() {
  const message: ChatMessage = {
    id: "playground-needs-input-resolution-notice-msg",
    role: "user",
    content: [
      "[Needs-input resolution notice]",
      "Resolved same-session same-thread needs-input (q-1431): 1.",
      "  487. confirm collapsible commits section quest (answered in notification UI).",
      "Do not run `takode notify resolve` for these same-session prompts unless a new prompt is recreated later.",
    ].join("\n"),
    timestamp: Date.now() - 25_000,
    agentSource: NEEDS_INPUT_RESOLUTION_SOURCE,
    metadata: {
      threadKey: "q-1431",
      questId: "q-1431",
      threadRefs: [{ threadKey: "q-1431", questId: "q-1431", source: "explicit" }],
    },
  };

  return <MessageBubble message={message} sessionId="playground-needs-input-resolution-notice" showTimestamp={false} />;
}

export function PlaygroundThreadRoutingReminderMessage() {
  const message: ChatMessage = {
    id: "playground-thread-routing-reminder-msg",
    role: "user",
    content: [
      "[Thread routing reminder]",
      "Missing thread marker. Your previous leader response was not assigned to a thread.",
      "Resend user-visible leader text with `[thread:main]` or `[thread:q-N]` as the first line.",
      "For leader shell commands, put `# thread:main` or `# thread:q-N` as the first non-empty command line.",
    ].join("\n"),
    timestamp: Date.now() - 20_000,
    agentSource: {
      sessionId: THREAD_ROUTING_REMINDER_SOURCE_ID,
      sessionLabel: THREAD_ROUTING_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "q-970", questId: "q-970" },
  };

  return <MessageBubble message={message} sessionId="playground-thread-routing-reminder" showTimestamp={false} />;
}

export function PlaygroundQuestThreadReminderMessage() {
  const message: ChatMessage = {
    id: "playground-quest-thread-reminder-msg",
    role: "user",
    content:
      "Thread reminder: attach any prior messages that clearly belong to [q-1025](quest:q-1025) with `takode thread attach`.",
    timestamp: Date.now() - 18_000,
    agentSource: {
      sessionId: QUEST_THREAD_REMINDER_SOURCE_ID,
      sessionLabel: QUEST_THREAD_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "q-1025", questId: "q-1025" },
  };

  return <MessageBubble message={message} sessionId="playground-quest-thread-reminder" showTimestamp={false} />;
}

export function PlaygroundThreadOutcomeReminderMessage() {
  const message: ChatMessage = {
    id: "playground-thread-outcome-reminder-msg",
    role: "user",
    content: [
      "Thread outcome reminder: mark every touched leader thread with a fresh outcome before idling.",
      "Missing outcome marker for: Main.",
      'Use `takode notify needs-input "..."` only for user-blocking prompts. For non-blocking thread status, add a standalone `{[(Thread Waiting: thread | summary)]}` or `{[(Thread Ready: thread | summary)]}` line to your assistant response.',
    ].join("\n"),
    timestamp: Date.now() - 16_000,
    agentSource: {
      sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
      sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "main" },
  };

  return <MessageBubble message={message} sessionId="playground-thread-outcome-reminder" showTimestamp={false} />;
}

export function PlaygroundHistoricalThreadOutcomeReminderMessage() {
  const message: ChatMessage = {
    id: "playground-historical-thread-outcome-reminder-msg",
    role: "user",
    content: [
      "Thread outcome reminder: mark every touched leader thread with a fresh outcome before idling.",
      "Missing outcome marker for: Main.",
      'Use `takode notify needs-input "..."` only for user-blocking prompts. For non-blocking thread status, add a standalone `{[(Thread Waiting: thread | summary)]}` or `{[(Thread Ready: thread | summary)]}` line to your assistant response.',
    ].join("\n"),
    timestamp: Date.now() - 16_000,
    agentSource: {
      sessionId: THREAD_OUTCOME_REMINDER_SOURCE_ID,
      sessionLabel: THREAD_OUTCOME_REMINDER_SOURCE_LABEL,
    },
    metadata: { threadKey: "main" },
    threadOutcomeReminder: {
      status: "satisfied",
      notificationId: "n-playground-approval",
      notificationSummary: "Approve worker dispatch",
      satisfiedAt: Date.now() - 12_000,
    },
  };

  return <MessageBubble message={message} sessionId="playground-thread-outcome-reminder" showTimestamp={false} />;
}

export function PlaygroundResourceLeaseMessage() {
  const message: ChatMessage = {
    id: "playground-resource-lease-msg",
    role: "user",
    content: [
      "[Resource lease acquired] You now hold `agent-browser`.",
      "",
      "Purpose: Validate injected reminder chips",
      "Expires: 2026-05-10T04:00:00.000Z",
      "",
      "Heartbeat with `takode lease renew agent-browser`; release with `takode lease release agent-browser` when done.",
    ].join("\n"),
    timestamp: Date.now() - 15_000,
    agentSource: { sessionId: "resource-lease:agent-browser", sessionLabel: "Resource Lease" },
  };

  return <MessageBubble message={message} sessionId="playground-resource-lease" showTimestamp={false} />;
}

export function PlaygroundLongSleepGuardMessage() {
  const message: ChatMessage = {
    id: "playground-long-sleep-guard-msg",
    role: "user",
    content: "Do not use `sleep` longer than 1 minute. Use `takode timer` instead of long sleeps or polling waits.",
    timestamp: Date.now() - 14_500,
    agentSource: { sessionId: "system:long-sleep-guard", sessionLabel: "System" },
  };

  return <MessageBubble message={message} sessionId="playground-long-sleep-guard" showTimestamp={false} />;
}

export function PlaygroundRestartContinuationMessage() {
  const message: ChatMessage = {
    id: "playground-restart-continuation-msg",
    role: "user",
    content: "Continue.",
    timestamp: Date.now() - 14_000,
    agentSource: { sessionId: "system:restart-continuation:prep-1", sessionLabel: "System" },
  };

  return <MessageBubble message={message} sessionId="playground-restart-continuation" showTimestamp={false} />;
}

export function PlaygroundCompactionRecoveryEventMessage() {
  const message: ChatMessage = {
    id: "playground-compaction-recovery-event-msg",
    role: "user",
    content: [
      "Context was compacted. Before continuing, recover enough context from your own session history to safely resume work:",
      "",
      "1. Inspect your own session history with Takode tools. Start with `takode scan 1639`",
      "2. Re-read the quest or latest assignment only after recovering enough context.",
    ].join("\n"),
    timestamp: Date.now() - 14_000,
    agentSource: {
      sessionId: COMPACTION_RECOVERY_SOURCE_ID,
      sessionLabel: COMPACTION_RECOVERY_SOURCE_LABEL,
    },
  };

  return <MessageBubble message={message} sessionId="playground-compaction-recovery-event" showTimestamp={false} />;
}

export function PlaygroundLeaderKickoffEventMessage() {
  const message: ChatMessage = {
    id: "playground-leader-kickoff-event-msg",
    role: "user",
    content: [
      "[System] You are a leader session. Your job is to coordinate worker sessions through the phase-based Quest Journey lifecycle.",
      "",
      "**On startup**: The required leader skill contents are included immediately after this kickoff message. Do not reread those mandatory leader skills via tool calls unless checking freshness or debugging.",
    ].join("\n"),
    timestamp: Date.now() - 12_000,
    agentSource: {
      sessionId: LEADER_KICKOFF_SOURCE_ID,
      sessionLabel: LEADER_KICKOFF_SOURCE_LABEL,
    },
  };

  return <MessageBubble message={message} sessionId="playground-leader-kickoff-event" showTimestamp={false} />;
}

export function PlaygroundLeaderSkillPreloadEventMessage() {
  const skillName = "takode-orchestration";
  const message: ChatMessage = {
    id: "playground-leader-skill-preload-event-msg",
    role: "user",
    content: [
      `Required leader skill preloaded: ${skillName}`,
      "",
      "Use this content as already-loaded leader context. Do not reread this mandatory skill via tool calls unless checking freshness or debugging.",
      "",
      "---",
      "name: takode-orchestration",
      "description: Cross-session orchestration for Takode.",
      "---",
      "",
      "# Takode -- Cross-Session Orchestration",
    ].join("\n"),
    timestamp: Date.now() - 11_000,
    agentSource: {
      sessionId: leaderSkillPreloadSourceId(skillName),
      sessionLabel: leaderSkillPreloadSourceLabel(skillName),
    },
  };

  return <MessageBubble message={message} sessionId="playground-leader-skill-preload-event" showTimestamp={false} />;
}

export function PlaygroundMemoryCatalogEventMessage({ truncated = false }: { truncated?: boolean }) {
  const message: ChatMessage = {
    id: truncated ? "playground-memory-catalog-truncated-event-msg" : "playground-memory-catalog-event-msg",
    role: "user",
    content: [
      MEMORY_CATALOG_TITLE,
      "",
      ...(truncated
        ? [
            MEMORY_CATALOG_TRUNCATED_PREFIX + " the catalog hit Takode's 100,000 character injected-context limit.",
            "The preloaded content is truncated. If you need the full current catalog, run `memory catalog show`; for freshness since this injection, use `memory catalog diff`. Inspect relevant Markdown files directly before relying on memory facts.",
            "",
          ]
        : []),
      "This automatically injected catalog is the result of `memory catalog show` at injection time. Treat it as an orientation snapshot, not the source of truth.",
      "For freshness after injection, prefer `memory catalog diff` or inspect the actual Markdown files directly with normal tools such as `memory repo path`, `sed`, `rg`, and `cat` instead of reflexively rerunning `memory catalog show`.",
      "",
      "Memory repo: /Users/example/.companion/memory/prod/Takode",
      "decisions/memory-repo-native-design.md: Takode memory is a Git-tracked Markdown repo whose files are the source of truth.",
      "procedures/memory-agent-workflow.md: Discover memory with the catalog, inspect Markdown directly, and write memory with locks.",
    ].join("\n"),
    timestamp: Date.now() - 10_000,
    agentSource: {
      sessionId: MEMORY_CATALOG_SOURCE_ID,
      sessionLabel: MEMORY_CATALOG_SOURCE_LABEL,
    },
  };

  return <MessageBubble message={message} sessionId="playground-memory-catalog-event" showTimestamp={false} />;
}

// ─── Inline MCP Server Row (static preview, no WebSocket) ──────────────────

export function PlaygroundMcpRow({ server }: { server: McpServerDetail }) {
  const [expanded, setExpanded] = useState(false);
  const statusMap: Record<string, { label: string; cls: string; dot: string }> = {
    connected: { label: "Connected", cls: "text-cc-success bg-cc-success/10", dot: "bg-cc-success" },
    connecting: { label: "Connecting", cls: "text-cc-warning bg-cc-warning/10", dot: "bg-cc-warning animate-pulse" },
    failed: { label: "Failed", cls: "text-cc-error bg-cc-error/10", dot: "bg-cc-error" },
    disabled: { label: "Disabled", cls: "text-cc-muted bg-cc-hover", dot: "bg-cc-muted opacity-40" },
  };
  const badge = statusMap[server.status] || statusMap.disabled;

  return (
    <div className="rounded-lg border border-cc-border bg-cc-bg">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${badge.dot}`} />
        <button onClick={() => setExpanded(!expanded)} className="flex-1 min-w-0 text-left cursor-pointer">
          <span className="text-[12px] font-medium text-cc-fg truncate block">{server.name}</span>
        </button>
        <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-cc-border pt-2">
          <div className="text-[11px] text-cc-muted space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Type:</span>
              <span>{server.config.type}</span>
            </div>
            {server.config.command && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">Cmd:</span>
                <span className="font-mono text-[10px] break-all">
                  {server.config.command}
                  {server.config.args?.length ? ` ${server.config.args.join(" ")}` : ""}
                </span>
              </div>
            )}
            {server.config.url && (
              <div className="flex items-start gap-1">
                <span className="text-cc-muted/60 shrink-0">URL:</span>
                <span className="font-mono text-[10px] break-all">{server.config.url}</span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-cc-muted/60">Scope:</span>
              <span>{server.scope}</span>
            </div>
          </div>
          {server.error && (
            <div className="text-[11px] text-cc-error bg-cc-error/5 rounded px-2 py-1">{server.error}</div>
          )}
          {server.tools && server.tools.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-cc-muted uppercase tracking-wider">Tools ({server.tools.length})</span>
              <div className="flex flex-wrap gap-1">
                {server.tools.map((tool) => (
                  <span key={tool.name} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-cc-hover text-cc-fg">
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Timer Modal Demo ────────────────────────────────────────────────────────

export function PlaygroundHoverCrossLinkDemo({ text }: { text: string }) {
  useEffect(() => {
    useStore.setState((state) => {
      const nextSdkSessions = [...state.sdkSessions];
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-leader")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-leader",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 180000,
          sessionNum: 565,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4",
          repoRoot: "/Users/stan/Dev/takode",
          isOrchestrator: true,
          name: "Leader Hover Demo",
        });
      }
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-worker")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-worker",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 120000,
          sessionNum: 566,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4-mini",
          repoRoot: "/Users/stan/Dev/takode",
          herdedBy: "playground-hover-leader",
          notificationUrgency: "needs-input",
          activeNotificationCount: 2,
          activeNeedsInputNotificationCount: 2,
          name: "Worker Hover Demo",
        });
      }
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-reviewer")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-reviewer",
          state: "connected",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 90000,
          sessionNum: 567,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4",
          repoRoot: "/Users/stan/Dev/takode",
          name: "Reviewer Hover Demo",
        });
      }

      const nextQuests = [...state.quests];
      const hoverQuest = {
        id: "q-418-v2",
        questId: "q-418",
        version: 2,
        title: "Improve quest link preview layout and orchestration details",
        status: "in_progress" as const,
        description: "Keep quest hover previews spacious while surfacing orchestration context.",
        createdAt: Date.now() - 240000,
        sessionId: "playground-hover-worker",
        claimedAt: Date.now() - 180000,
        leaderSessionId: "playground-hover-leader",
        tags: ["ui", "quests", "links", "journey"],
      };
      const leaderAlignmentQuest = {
        id: "q-419-v1",
        questId: "q-419",
        version: 1,
        title: "Align leader hover active quest details with the Journey summary",
        status: "refined" as const,
        description: "Playground fixture for leader hover active quest rows in different phases.",
        createdAt: Date.now() - 210000,
        leaderSessionId: "playground-hover-leader",
        tags: ["ui", "leader-sessions", "journey"],
      };
      const existingQuestIndex = nextQuests.findIndex((quest) => quest.questId === "q-418");
      if (existingQuestIndex >= 0) {
        nextQuests[existingQuestIndex] = { ...nextQuests[existingQuestIndex], ...hoverQuest };
      } else {
        nextQuests.push(hoverQuest);
      }
      const existingAlignmentQuestIndex = nextQuests.findIndex((quest) => quest.questId === "q-419");
      if (existingAlignmentQuestIndex >= 0) {
        nextQuests[existingAlignmentQuestIndex] = {
          ...nextQuests[existingAlignmentQuestIndex],
          ...leaderAlignmentQuest,
        };
      } else {
        nextQuests.push(leaderAlignmentQuest);
      }

      const nextSessionBoards = new Map(state.sessionBoards);
      const leaderBoard = (nextSessionBoards.get("playground-hover-leader") ?? []).filter(
        (row) => row.questId !== "q-418" && row.questId !== "q-419",
      );
      nextSessionBoards.set("playground-hover-leader", [
        {
          questId: "q-418",
          title: hoverQuest.title,
          worker: "playground-hover-worker",
          workerNum: 566,
          status: "WORKING",
          updatedAt: Date.now() - 60000,
          journey: {
            mode: "active",
            phaseIds: ["alignment", "work", "memory"],
            currentPhaseId: "work",
          },
        },
        {
          questId: "q-419",
          title: leaderAlignmentQuest.title,
          status: "PLANNING",
          updatedAt: Date.now() - 30000,
          journey: {
            mode: "active",
            phaseIds: ["alignment", "work", "memory"],
            currentPhaseId: "alignment",
          },
        },
        ...leaderBoard,
      ]);
      const nextSessionBoardRowStatuses = new Map(state.sessionBoardRowStatuses);
      nextSessionBoardRowStatuses.set("playground-hover-leader", {
        ...(nextSessionBoardRowStatuses.get("playground-hover-leader") ?? {}),
        "q-418": {
          worker: {
            sessionId: "playground-hover-worker",
            sessionNum: 566,
            name: "Worker Hover Demo",
            status: "running",
          },
          reviewer: {
            sessionId: "playground-hover-reviewer",
            sessionNum: 567,
            name: "Reviewer Hover Demo",
            status: "idle",
          },
        },
      });

      return {
        ...state,
        sdkSessions: nextSdkSessions,
        quests: nextQuests,
        sessionBoards: nextSessionBoards,
        sessionBoardRowStatuses: nextSessionBoardRowStatuses,
      };
    });
  }, []);

  return (
    <div className="space-y-2 p-3">
      <div className="rounded-xl border border-cc-border bg-cc-card/40 px-3 py-2.5">
        <MarkdownContent text={text} />
      </div>
    </div>
  );
}

export function PlaygroundMessageLinkHoverDemo() {
  useEffect(() => {
    useStore.setState((state) => {
      const nextSdkSessions = [...state.sdkSessions];
      if (!nextSdkSessions.some((session) => session.sessionId === "playground-hover-worker")) {
        nextSdkSessions.push({
          sessionId: "playground-hover-worker",
          state: "running",
          cwd: "/Users/stan/Dev/takode",
          createdAt: Date.now() - 120000,
          sessionNum: 566,
          cliConnected: true,
          backendType: "codex",
          model: "gpt-5.4-mini",
          repoRoot: "/Users/stan/Dev/takode",
          name: "Worker Hover Demo",
        });
      }

      return { ...state, sdkSessions: nextSdkSessions };
    });

    const originalFetchMessagePreview = api.fetchMessagePreview;
    api.fetchMessagePreview = async (sessionId: string, messageIndex: number) => {
      if (sessionId === "playground-hover-worker" && messageIndex === 212) {
        return {
          id: "playground-hover-message-212",
          role: "assistant",
          content: "The actual linked message renders here with the same message bubble primitives as chat.",
          contentBlocks: [
            {
              type: "text",
              text: "The actual linked message renders here with the same message bubble primitives as chat.",
            },
          ],
          timestamp: Date.now() - 60000,
        };
      }
      return originalFetchMessagePreview(sessionId, messageIndex);
    };

    return () => {
      api.fetchMessagePreview = originalFetchMessagePreview;
    };
  }, []);

  return (
    <div className="space-y-2 p-3">
      <div className="text-xs text-cc-muted">
        Hover the message link to preview the referenced message with reduced session chrome.
      </div>
      <div className="rounded-xl border border-cc-border bg-cc-card/40 px-3 py-2.5">
        <MarkdownContent text="Hover [#566 msg 212](session:566:212) to preview the linked message instead of a generic session summary." />
      </div>
    </div>
  );
}

export function TimerModalDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium px-3 py-1.5 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition-colors cursor-pointer"
      >
        Open timer modal
      </button>
      {open && <TimerModal sessionId="playground-timers" onClose={() => setOpen(false)} />}
    </>
  );
}

// ─── Inline Lightbox Demo ───────────────────────────────────────────────────

export function PlaygroundLightboxDemo() {
  const [open, setOpen] = useState(false);
  // A small gradient placeholder image — enough to demonstrate the lightbox
  const demoSrc =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#ec4899"/>' +
        "</linearGradient></defs>" +
        '<rect width="800" height="600" fill="url(#g)"/>' +
        '<text x="400" y="300" text-anchor="middle" fill="white" font-size="32" font-family="sans-serif">Full-size preview</text>' +
        "</svg>",
    );

  return (
    <div>
      <p className="text-xs text-cc-muted mb-2">Click the image below to open the lightbox:</p>
      <img
        src={demoSrc}
        alt="Lightbox demo"
        className="max-w-[200px] max-h-[150px] rounded-lg object-cover cursor-zoom-in hover:opacity-80 transition-opacity border border-cc-border"
        onClick={() => setOpen(true)}
        data-testid="playground-lightbox-trigger"
      />
      {open && <Lightbox src={demoSrc} alt="Lightbox demo" onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * Playground demo for the Selection Context Menu.
 * Shows a mock assistant message with simulated highlighted text and a static context menu.
 */
export function PlaygroundSelectionContextMenu() {
  const [menuOpen, setMenuOpen] = useState(true);

  // Static menu items matching the real SelectionContextMenu
  const menuItems: ContextMenuItem[] = [
    { label: "Quote selected", onClick: () => setMenuOpen(false) },
    {
      label: "Copy",
      onClick: () => {},
      children: [
        { label: "Rich text", onClick: () => {} },
        { label: "Markdown", onClick: () => {} },
        { label: "Plain text", onClick: () => {} },
      ],
    },
  ];

  return (
    <div className="relative" style={{ minHeight: 180 }}>
      {/* Mock assistant message with simulated text selection */}
      <div className="flex items-start gap-3">
        <PawTrailAvatar />
        <div className="flex-1 min-w-0">
          <div className="markdown-body text-[14px] text-cc-fg leading-relaxed">
            <p className="mb-3">Here are the key design principles for the new architecture:</p>
            <p className="mb-3">
              1.{" "}
              <mark
                style={{
                  background: "rgba(56, 132, 244, 0.3)",
                  borderRadius: 2,
                  padding: "1px 0",
                }}
              >
                Leader has zero extra indentation -- no toggle arrow before it. It looks exactly like a standalone
                session.
              </mark>
            </p>
            <p className="mb-3 last:mb-0">2. Herd summary bar sits directly below the leader.</p>
          </div>
        </div>
      </div>

      {/* Static context menu positioned above the "selected" text */}
      {menuOpen && <ContextMenu x={100} y={4} items={menuItems} onClose={() => setMenuOpen(false)} />}

      {/* Re-open button if closed */}
      {!menuOpen && (
        <button
          onClick={() => setMenuOpen(true)}
          className="mt-3 text-xs text-cc-primary hover:underline cursor-pointer"
        >
          Show menu again
        </button>
      )}
    </div>
  );
}

// ─── Inline TaskRow (avoids store dependency from TaskPanel) ────────────────

export function TaskRow({ task }: { task: TaskItem }) {
  const isCompleted = task.status === "completed";
  const isInProgress = task.status === "in_progress";

  return (
    <div className={`px-2.5 py-2 rounded-lg ${isCompleted ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 flex items-center justify-center w-4 h-4 mt-px">
          {isInProgress ? (
            <svg className="w-4 h-4 text-cc-primary animate-spin" viewBox="0 0 16 16" fill="none">
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="28"
                strokeDashoffset="8"
                strokeLinecap="round"
              />
            </svg>
          ) : isCompleted ? (
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-success">
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-cc-muted">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </span>
        <span
          className={`text-[13px] leading-snug flex-1 ${isCompleted ? "text-cc-muted line-through" : "text-cc-fg"}`}
        >
          {task.subject}
        </span>
      </div>
      {isInProgress && task.activeForm && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted italic truncate">{task.activeForm}</p>
      )}
      {task.blockedBy && task.blockedBy.length > 0 && (
        <p className="mt-1 ml-6 text-[11px] text-cc-muted flex items-center gap-1">
          <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 shrink-0">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 8h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span>blocked by {task.blockedBy.map((b) => `#${b}`).join(", ")}</span>
        </p>
      )}
    </div>
  );
}

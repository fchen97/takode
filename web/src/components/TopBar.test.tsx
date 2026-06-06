// @vitest-environment jsdom
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { LeaderWorkboardView } from "../store-types.js";
import {
  SESSION_NAVIGATION_PROJECTION,
  sessionNavigationProjectionToSessionFields,
} from "../../shared/session-navigation-projection.js";
import { syncedProjectionEntryId } from "../../shared/synced-projection.js";
import { LEADER_THREAD_TABS_PROJECTION } from "../../shared/leader-thread-tabs-projection.js";
import {
  createLeaderThreadTabsProjectionTab,
  createLeaderThreadTabsProjectionValue,
} from "../test-fixtures/leader-thread-tabs-projection.js";
import { createSessionNavigationProjectionValue } from "../test-fixtures/session-navigation-projection.js";

const mockNavigateTo = vi.fn();
const mockNavigateToSession = vi.fn();

vi.mock("../api.js", () => ({
  api: {
    relaunchSession: vi.fn().mockResolvedValue({ ok: true }),
    renameSession: vi.fn().mockResolvedValue({ ok: true }),
    archiveSession: vi.fn().mockResolvedValue({ ok: true }),
    archiveGroup: vi.fn().mockResolvedValue({ ok: true }),
    deleteSession: vi.fn().mockResolvedValue({ ok: true }),
    pauseSession: vi.fn().mockResolvedValue({ ok: true }),
    unpauseSession: vi.fn().mockResolvedValue({ ok: true }),
    getSessionNotifications: vi.fn().mockResolvedValue([]),
    getBackendModels: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({ sessionDefaults: undefined }),
    updateSessionConfig: vi.fn().mockResolvedValue({ ok: true, restartRequired: false, session: {}, sessionState: {} }),
    fetchNotificationContext: vi.fn().mockResolvedValue(null),
    markNotificationDone: vi.fn().mockResolvedValue({ ok: true }),
    updateLeaderProfilePortrait: vi.fn(),
  },
}));
vi.mock("../utils/navigation.js", () => ({
  navigateTo: (...args: unknown[]) => mockNavigateTo(...args),
  navigateToSession: (...args: unknown[]) => mockNavigateToSession(...args),
}));
vi.mock("../ws.js", () => ({
  sendToSession: vi.fn(() => true),
}));
vi.mock("./SessionInfoPopover.js", () => ({
  SessionInfoPopover: ({
    anchorElement,
    onConfigure,
  }: {
    anchorElement?: HTMLElement | null;
    onConfigure?: (sessionId: string) => void;
  }) => (
    <div data-testid="session-info-popover" data-anchor-present={anchorElement ? "true" : "false"}>
      <button type="button" data-testid="mock-session-info-configure" onClick={() => onConfigure?.("s1")}>
        Configure Session
      </button>
    </div>
  ),
}));
vi.mock("./BoardTable.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./BoardTable.js")>();
  return {
    ...actual,
    BoardTable: ({
      board,
      mode = "active",
    }: {
      board: Array<{ questId: string; status?: string; updatedAt: number }>;
      mode?: string;
    }) => (
      <div data-testid="board-table" data-mode={mode}>
        {board.length} rows
      </div>
    ),
  };
});

interface MockStoreState {
  currentSessionId: string | null;
  zoomLevel: number;
  cliConnected: Map<string, boolean>;
  cliDisconnectReason: Map<string, "idle_limit" | null>;
  sessionStatus: Map<string, "idle" | "running" | "compacting" | null>;
  sessionTimers: Map<string, Array<{ id: string }>>;
  sidebarOpen: boolean;
  setSidebarOpen: ReturnType<typeof vi.fn>;
  setSessionInfoOpenSessionId: ReturnType<typeof vi.fn>;
  codexSubagentInspector: { sessionId: string } | null;
  openCodexSubagentInspector: ReturnType<typeof vi.fn>;
  closeCodexSubagentInspector: ReturnType<typeof vi.fn>;
  taskPanelOpen: boolean;
  setTaskPanelOpen: ReturnType<typeof vi.fn>;
  activeTab: "chat" | "diff";
  setActiveTab: ReturnType<typeof vi.fn>;
  sessions: Map<
    string,
    {
      cwd?: string;
      permissionMode?: string;
      backend_type?: string;
      claimedQuestStatus?: string;
      claimedQuestVerificationInboxUnread?: boolean;
      isOrchestrator?: boolean;
      pause?: any;
      codex_native_subagents?: any;
    }
  >;
  sdkSessions: {
    sessionId: string;
    createdAt: number;
    archived?: boolean;
    isWorktree?: boolean;
    containerId?: string;
    hostId?: string | null;
    herdedBy?: string;
    cwd?: string;
    name?: string;
    sessionNum?: number | null;
    model?: string;
    permissionMode?: string;
    backendType?: string;
    cliSessionId?: string | null;
    cliConnected?: boolean;
    state?: "idle" | "starting" | "connected" | "running" | "compacting" | "exited" | null;
    claimedQuestStatus?: string | null;
    claimedQuestVerificationInboxUnread?: boolean;
    pause?: any;
    pausedInputQueueCount?: number;
    pendingTimerCount?: number;
    isOrchestrator?: boolean;
    leaderProfilePortrait?: {
      id: string;
      poolId: string;
      label: string;
      smallUrl: string;
      largeUrl: string;
      smallSize: number;
      largeSize: number;
      smallBytes: number;
      largeBytes: number;
    };
  }[];
  updateSdkSession: ReturnType<typeof vi.fn>;
  changedFiles: Map<string, Set<string>>;
  pendingPermissions: Map<string, Map<string, unknown>>;
  sessionAttention: Map<string, "action" | "error" | "review" | null>;
  sessionNotifications: Map<string, Array<any>>;
  sessionNames: Map<string, string>;
  treeGroups: Array<{ id: string; name: string }>;
  treeAssignments: Map<string, string>;
  diffFileStats: Map<string, Map<string, { additions: number; deletions: number }>>;
  sessionBoards: Map<
    string,
    Array<{ questId: string; status?: string; updatedAt: number; worker?: string; workerNum?: number }>
  >;
  sessionBoardRowStatuses: Map<string, Record<string, unknown>>;
  sessionCompletedBoards: Map<
    string,
    Array<{ questId: string; status?: string; updatedAt: number; completedAt?: number }>
  >;
  leaderWorkboardViews: Map<string, LeaderWorkboardView>;
  setLeaderWorkboardView: ReturnType<typeof vi.fn>;
  quests: { status: string }[];
  questSummary: { active: number } | null;
  refreshQuestSummary: ReturnType<typeof vi.fn>;
  questNamedSessions: Set<string>;
  sessionPreviews: Map<string, string>;
  syncedProjectionValues: Map<string, unknown>;
  syncedProjectionKeys: Set<string>;
  sessionTaskHistory: Map<string, unknown[]>;
  askPermission: Map<string, boolean>;
  activeTurnRoutes: Map<string, unknown>;
  shortcutSettings?: {
    enabled: boolean;
    preset: "standard" | "vscode-light" | "vim-light";
    overrides: Record<string, string | null>;
  };
  openSessionSearch: ReturnType<typeof vi.fn>;
  closeSessionSearch: ReturnType<typeof vi.fn>;
  setSessionNotifications: ReturnType<typeof vi.fn>;
  requestScrollToMessage: ReturnType<typeof vi.fn>;
  setExpandAllInTurn: ReturnType<typeof vi.fn>;
  requestBottomAlignOnNextUserMessage: ReturnType<typeof vi.fn>;
}

let storeState: MockStoreState;

function leaderProjectionState(sessionId = "s1") {
  const entryId = syncedProjectionEntryId(LEADER_THREAD_TABS_PROJECTION, sessionId);
  return {
    syncedProjectionValues: new Map([
      [
        entryId,
        createLeaderThreadTabsProjectionValue({
          tabs: [
            createLeaderThreadTabsProjectionTab("q-1", { active: true, canClose: false }),
            createLeaderThreadTabsProjectionTab("q-2", { completed: true }),
          ],
          mainAttention: {},
          threadStatuses: {},
          activePhaseSummary: [{ label: "Implement", count: 1, tone: "phase" }],
        }),
      ],
    ]),
    syncedProjectionKeys: new Set([entryId]),
  };
}

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    currentSessionId: "s1",
    zoomLevel: 1,
    cliConnected: new Map([["s1", true]]),
    cliDisconnectReason: new Map(),
    sessionStatus: new Map([["s1", "idle"]]),
    sessionTimers: new Map(),
    sidebarOpen: true,
    setSidebarOpen: vi.fn(),
    setSessionInfoOpenSessionId: vi.fn(),
    codexSubagentInspector: null,
    openCodexSubagentInspector: vi.fn(),
    closeCodexSubagentInspector: vi.fn(),
    taskPanelOpen: false,
    setTaskPanelOpen: vi.fn(),
    activeTab: "chat",
    setActiveTab: vi.fn(),
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    updateSdkSession: vi.fn(),
    changedFiles: new Map(),
    pendingPermissions: new Map(),
    sessionAttention: new Map(),
    treeGroups: [],
    treeAssignments: new Map(),
    sessionNotifications: new Map(),
    sessionNames: new Map(),
    diffFileStats: new Map(),
    sessionBoards: new Map(),
    sessionBoardRowStatuses: new Map(),
    sessionCompletedBoards: new Map(),
    leaderWorkboardViews: new Map(),
    setLeaderWorkboardView: vi.fn(),
    quests: [],
    questSummary: null,
    refreshQuestSummary: vi.fn().mockResolvedValue(undefined),
    questNamedSessions: new Set(),
    sessionPreviews: new Map(),
    syncedProjectionValues: new Map(),
    syncedProjectionKeys: new Set(),
    sessionTaskHistory: new Map(),
    askPermission: new Map(),
    activeTurnRoutes: new Map(),
    shortcutSettings: { enabled: false, preset: "standard", overrides: {} },
    openSessionSearch: vi.fn(),
    closeSessionSearch: vi.fn(),
    setSessionNotifications: vi.fn(),
    requestScrollToMessage: vi.fn(),
    setExpandAllInTurn: vi.fn(),
    requestBottomAlignOnNextUserMessage: vi.fn(),
    ...overrides,
  };
  if (!overrides.setLeaderWorkboardView) {
    storeState.setLeaderWorkboardView = vi.fn((sessionId: string, view: LeaderWorkboardView | null) => {
      if (view) storeState.leaderWorkboardViews.set(sessionId, view);
      else storeState.leaderWorkboardViews.delete(sessionId);
    });
  }
}

vi.mock("../store.js", () => {
  const useStore: any = (selector: (s: MockStoreState) => unknown) => selector(storeState);
  useStore.getState = () => storeState;
  return {
    useStore,
    getSessionSearchState: () => ({
      query: "",
      isOpen: false,
      mode: "strict",
      category: "all",
      matches: [],
      currentMatchIndex: -1,
    }),
  };
});

import { getCurrentTopBarSessionState, TopBar } from "./TopBar.js";
import { WorkBoardBar } from "./WorkBoardBar.js";
import { getGlobalNeedsInputEntries } from "../utils/global-needs-input.js";
import { api } from "../api.js";
import { resetAttentionCursorsForTest } from "../hooks/useAttentionNavigator.js";
import { ATTENTION_NEXT_EVENT } from "./GlobalAttentionMenu.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetAttentionCursorsForTest();
  window.innerWidth = 1280;
  window.location.hash = "";
  localStorage.clear();
  localStorage.setItem("cc-server-id", "test-server");
  resetStore();
});

describe("TopBar session menu", () => {
  beforeEach(() => {
    resetStore({
      sidebarOpen: false,
      sdkSessions: [
        { sessionId: "other", createdAt: 1, name: "Other session", sessionNum: 10, backendType: "codex" },
        {
          sessionId: "s1",
          createdAt: 2,
          name: "Viewed session",
          sessionNum: 11,
          backendType: "codex",
          state: "connected",
        },
      ],
    });
  });

  function openMenu() {
    return fireEvent.contextMenu(screen.getByTitle("Viewed session"), { clientX: 230, clientY: 35 });
  }

  it("relaunches the viewed session from the title with the sidebar closed", () => {
    // The title must work without a mounted sidebar or a sidebar selection lookup.
    render(<TopBar />);
    expect(openMenu()).toBe(false);
    expect(screen.getByRole("button", { name: "Relaunch" }).closest(".fixed")).toHaveStyle({
      left: "230px",
      top: "35px",
    });
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    expect(api.relaunchSession).toHaveBeenCalledExactlyOnceWith("s1");
    expect(screen.queryByRole("button", { name: "Relaunch" })).not.toBeInTheDocument();
    expect(storeState.setSidebarOpen).not.toHaveBeenCalled();
  });

  it("preserves left-click session info and dismisses it when opening the menu", () => {
    render(<TopBar />);
    fireEvent.click(screen.getByTitle("Viewed session"));
    expect(screen.getByTestId("session-info-popover")).toBeInTheDocument();
    openMenu();
    expect(screen.queryByTestId("session-info-popover")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Relaunch" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Viewed session"));
    expect(screen.getByTestId("session-info-popover")).toBeInTheDocument();
  });

  it("opens the menu on touch long-press and keeps it open through iOS's emulated mouse events", () => {
    // After a long press iOS can still emulate mousedown/mouseup/click at
    // finger lift; they must not dismiss the menu or toggle session info.
    vi.useFakeTimers();
    try {
      render(<TopBar />);
      const title = screen.getByTitle("Viewed session");
      fireEvent.touchStart(title, { touches: [{ clientX: 230, clientY: 35 }] });
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole("button", { name: "Relaunch" })).toBeInTheDocument();

      fireEvent.touchEnd(title);
      fireEvent.mouseDown(title);
      fireEvent.mouseUp(title);
      fireEvent.click(title);
      expect(screen.getByRole("button", { name: "Relaunch" })).toBeInTheDocument();
      expect(screen.queryByTestId("session-info-popover")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Configure Session open after the context menu closes", async () => {
    render(<TopBar />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Configure Session" }));
    expect(await screen.findByRole("dialog", { name: "Configure Session" })).toBeInTheDocument();
    expect(screen.getByText(/Codex session settings for #11/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Relaunch" })).not.toBeInTheDocument();
  });

  it("renames in the header and supports cancelling without opening the sidebar", () => {
    render(<TopBar />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Session name" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(api.renameSession).toHaveBeenCalledExactlyOnceWith("s1", "New title");
    // The title stays server-authored until an authoritative update arrives.
    expect(screen.getByTitle("Viewed session")).toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), { target: { value: "Cancelled" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Escape" });
    expect(api.renameSession).toHaveBeenCalledTimes(1);
  });

  it.each(["archived", "exited", "paused"])("preserves %s action availability", (state) => {
    // These are the existing sidebar gates, rendered from the same menu component.
    const session = storeState.sdkSessions[1]!;
    if (state === "archived") session.archived = true;
    if (state === "exited") session.state = "exited";
    if (state === "paused") session.pause = { pausedAt: 1, queuedMessages: [] };
    render(<TopBar />);
    openMenu();
    expect(!!screen.queryByRole("button", { name: "Relaunch" })).toBe(state !== "archived" && state !== "exited");
    expect(!!screen.queryByRole("button", { name: "Configure Session" })).toBe(state !== "archived");
    if (state === "archived") expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
    if (state === "paused") expect(screen.getByRole("button", { name: "Unpause Session" })).toBeInTheDocument();
  });

  it.each(["worktree", "container", "leader"])("keeps the %s archive safeguard visible without a sidebar", (kind) => {
    const session = storeState.sdkSessions[1]!;
    if (kind === "container") session.containerId = "container";
    else session.isWorktree = true;
    if (kind === "leader") {
      session.isOrchestrator = true;
      storeState.sdkSessions[0]!.herdedBy = "s1";
    }
    render(<TopBar />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(api.archiveSession).not.toHaveBeenCalled();
    expect(api.archiveGroup).not.toHaveBeenCalled();
    if (kind === "leader") {
      expect(screen.getByText(/delete this leader's worktree/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Archive Leader Only" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Archive Leader + Herd" })).toBeInTheDocument();
    } else
      expect(
        screen.getByText(kind === "worktree" ? "delete the worktree" : "remove the container"),
      ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(api.archiveSession).not.toHaveBeenCalled();
  });

  it("keeps permanent deletion behind the existing confirmation", () => {
    render(<TopBar />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Delete Session" }));
    expect(screen.getByText("Delete session permanently?")).toBeInTheDocument();
    expect(api.deleteSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete Session" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("button", { name: "Delete Session" })).not.toBeInTheDocument();
  });

  it("closes the old menu on navigation and targets the newly viewed session", () => {
    const view = render(<TopBar />);
    openMenu();
    storeState.currentSessionId = "other";
    view.rerender(<TopBar />);
    expect(screen.queryByRole("button", { name: "Relaunch" })).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTitle("Other session"));
    fireEvent.click(screen.getByRole("button", { name: "Relaunch" }));
    expect(api.relaunchSession).toHaveBeenCalledExactlyOnceWith("other");
  });
});

describe("TopBar", () => {
  it.each([
    ["action", "idle"],
    ["review", "completed_unread"],
    ["error", "completed_unread"],
    [null, "idle"],
  ] as const)("keeps %s attention distinct from unread results", (reason, expectedStatus) => {
    // A needs-input prompt can remain after every result was read. Its
    // attention must not turn the selected session's header blue.
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, cliConnected: true, state: "idle" }],
      sessionAttention: new Map([["s1", reason]]),
    });

    render(<TopBar />);

    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", expectedStatus);
  });

  it("derives the global needs-input aggregate from unresolved needs-input notifications only", () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s1", createdAt: 40, cliConnected: true, state: "running", sessionNum: 11, name: "One" },
        { sessionId: "s2", createdAt: 30, cliConnected: true, state: "idle", sessionNum: 12, name: "Two" },
        { sessionId: "archived", createdAt: 20, archived: true, sessionNum: 13, name: "Archived" },
      ],
      sessionNotifications: new Map([
        [
          "s1",
          [
            { id: "n-1", category: "needs-input", summary: "Need scope", timestamp: 3, messageId: "m1", done: false },
            { id: "review", category: "review", summary: "Review", timestamp: 4, messageId: "m2", done: false },
          ],
        ],
        [
          "s2",
          [
            { id: "done", category: "needs-input", summary: "Done", timestamp: 5, messageId: "m3", done: true },
            { id: "n-2", category: "needs-input", summary: "Need launch", timestamp: 6, messageId: "m4", done: false },
          ],
        ],
        [
          "archived",
          [{ id: "hidden", category: "needs-input", summary: "Archived", timestamp: 7, messageId: "m5", done: false }],
        ],
      ]),
    });

    const entries = getGlobalNeedsInputEntries(storeState as any);

    expect(entries.map((entry) => entry.notification.id)).toEqual(["n-2", "n-1"]);
    expect(entries.map((entry) => entry.sessionNum)).toEqual([12, 11]);
  });

  it("gives full-page headers the attention list instead of separate needs-input and Notify Me counts", () => {
    // The attention list already holds prompts and Notify Me results, so the two
    // count buttons were removed from full-page headers as well as the sessions panel.
    resetStore({
      sdkSessions: [{ sessionId: "s-unread", createdAt: 20, cliConnected: true, state: "idle" }],
      sessionAttention: new Map([["s-unread", "review"]]),
    });

    render(<TopBar fullPageLabel="Quests" />);

    expect(screen.getByTestId("attention-list-button")).toHaveTextContent("1");
    expect(
      screen.queryByRole("button", { name: /needs-input notifications? across sessions/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Notify Me:/ })).not.toBeInTheDocument();
  });

  it("keeps pause controls out of the top bar", () => {
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([["s1", { cwd: "/repo", pause: null }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 40, cliConnected: true, state: "connected", name: "Active" }],
    });

    render(<TopBar />);

    expect(screen.queryByTitle("Pause session")).not.toBeInTheDocument();
  });

  // Model, effort and access show as one line of text in the title, on desktop and on the
  // phone's second row. It is part of the title, so a tap on it opens Session Info, which
  // starts with the settings; there is no separate, small menu target.
  it.each([
    ["desktop", 1280],
    ["phone", 430],
  ])("shows the session settings in the title and opens Session Info from them on %s", (_layout, width) => {
    window.innerWidth = width;
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([["s1", { cwd: "/repo", model: "claude-opus-5.5", permissionMode: "acceptEdits" }]]),
      sdkSessions: [
        { sessionId: "s1", sessionNum: 7, createdAt: 1, cliConnected: true, state: "idle", name: "Active" },
      ],
    });

    render(<TopBar />);
    const settings = screen.getByTestId("session-settings-summary");
    expect(settings).toHaveTextContent("opus-5.5 · Accept edits");
    expect(settings.closest("button")).not.toBeNull();

    fireEvent.click(settings);
    expect(screen.getByTestId("session-info-popover")).toBeInTheDocument();
    expect(screen.queryByTestId("session-settings-menu")).toBeNull();
  });

  // The title names a remote session's host next to the session name, inside the
  // button that opens session info; local sessions keep the title unchanged.
  it("shows a remote session's host chip in the title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ hosts: [{ id: "h1", name: "devbox", online: true }] }))),
    );
    try {
      resetStore({
        currentSessionId: "s1",
        sessions: new Map([["s1", { cwd: "/srv" }]]),
        sdkSessions: [
          { sessionId: "s1", createdAt: 1, cliConnected: true, state: "idle", name: "Remote", hostId: "h1" },
        ],
      });
      render(<TopBar />);
      const chip = await screen.findByText("devbox");
      expect(chip.closest('[data-testid="session-host-badge"]')).toBeInTheDocument();
      expect(chip.closest("button")).toHaveAttribute("aria-label", "Remote");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses projected current-session status, permission, name, and timer authority", () => {
    resetStore({
      currentSessionId: "s1",
      sessionNames: new Map([["s1", "Stale name"]]),
      sessionStatus: new Map([["s1", "running"]]),
      sessionTimers: new Map([["s1", [{ id: "stale-timer" }]]]),
      pendingPermissions: new Map([["s1", new Map([["stale-permission", {}]])]]),
      questNamedSessions: new Set(["s1"]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, state: "running", name: "Stale name" }],
    });
    storeState.sdkSessions[0]!.isOrchestrator = true;
    storeState.sdkSessions[0]!.leaderProfilePortrait = {} as never;
    const entryId = syncedProjectionEntryId(SESSION_NAVIGATION_PROJECTION, "s1");
    storeState.syncedProjectionKeys.add(entryId);
    const navigation = createSessionNavigationProjectionValue({
      identity: { name: "Projected name" },
      lifecycle: { status: null, pendingPermissionCount: 0, pendingTimerCount: 0 },
    });
    storeState.syncedProjectionValues.set(entryId, navigation);
    storeState.sdkSessions[0] = {
      ...storeState.sdkSessions[0]!,
      ...sessionNavigationProjectionToSessionFields(navigation),
    };

    const current = getCurrentTopBarSessionState(storeState as never);

    expect(current).toMatchObject({
      sessionName: "Projected name",
      status: null,
      currentPermCount: 0,
      activeTimerCount: 0,
      isQuestNamed: false,
      leaderProfilePortrait: undefined,
    });
  });

  it("shows the timer status icon for an otherwise idle current session with active timers", () => {
    resetStore({
      currentSessionId: "s1",
      cliConnected: new Map([["s1", true]]),
      sessionStatus: new Map([["s1", "idle"]]),
      sessionTimers: new Map([["s1", [{ id: "timer-1" }]]]),
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          cliConnected: true,
          state: "connected",
          name: "Timed",
          pendingTimerCount: 1,
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByTestId("session-status-waiting-icon")).toHaveAttribute("data-count", "1");
    expect(screen.queryByTestId("session-status-dot")).toBeNull();
  });

  it("keeps running top-bar status ahead of active timers", () => {
    resetStore({
      currentSessionId: "s1",
      cliConnected: new Map([["s1", true]]),
      sessionStatus: new Map([["s1", "running"]]),
      sessionTimers: new Map([["s1", [{ id: "timer-1" }]]]),
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          cliConnected: true,
          state: "running",
          name: "Running",
          pendingTimerCount: 1,
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByTestId("session-status-dot")).toHaveAttribute("data-status", "running");
    expect(screen.queryByTestId("session-status-waiting-icon")).toBeNull();
  });

  it("uses route-owned chrome on full-page routes without showing the current session title", () => {
    resetStore({
      currentSessionId: "s1",
      sidebarOpen: false,
      taskPanelOpen: false,
      sessionNames: new Map([["s1", "Main Session"]]),
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 40, cliConnected: true, state: "connected", name: "Main Session" }],
    });

    render(<TopBar fullPageLabel="Memory" />);

    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.queryByText("Main Session")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open session panel" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Toggle sidebar"));
    expect(storeState.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it("does not expose paused-state controls in the top bar", () => {
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([
        [
          "s1",
          {
            cwd: "/repo",
            pause: {
              pausedAt: 123,
              queuedMessages: [
                { id: "p1", queuedAt: 124, source: "browser", message: { type: "user_message", content: "held" } },
                {
                  id: "p2",
                  queuedAt: 125,
                  source: "programmatic",
                  message: { type: "user_message", content: "later" },
                },
              ],
            },
          },
        ],
      ]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          cliConnected: false,
          state: "exited",
          name: "Emergency Hold",
          pause: {
            pausedAt: 123,
            queuedMessages: [],
          },
          pausedInputQueueCount: 2,
        },
      ],
      cliConnected: new Map([["s1", false]]),
    });

    render(<TopBar />);

    expect(screen.queryByText("Paused")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Unpause session (2 held inputs)")).not.toBeInTheDocument();
    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();
  });

  it("does not expose reconnect for archived selected sessions", () => {
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 40,
          archived: true,
          cliConnected: false,
          state: "exited",
          name: "Archived Leader",
          isOrchestrator: true,
        },
      ],
      cliConnected: new Map([["s1", false]]),
    });

    render(<TopBar />);

    expect(screen.getByText("Archived Leader")).toBeInTheDocument();
    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument();
  });

  it("lists muted prompts once, in a collapsed section below the open questions", () => {
    // Muted prompts moved here from the removed needs-input menu. They stay out of
    // the Needs input group and Next, so nothing shows twice.
    resetStore({
      sessionNotifications: new Map([
        [
          "s1",
          [
            { id: "n-1", category: "needs-input", summary: "Pick deployment window", timestamp: 1, messageId: "m1" },
            {
              id: "n-2",
              category: "needs-input",
              summary: "Confirm rollback plan",
              timestamp: 2,
              messageId: "m2",
              muted: true,
            },
          ],
        ],
      ]),
      sdkSessions: [{ sessionId: "s1", createdAt: 10, sessionNum: 101, name: "Worker One" }],
    });

    render(<TopBar fullPageLabel="Quests" />);
    fireEvent.click(screen.getByTestId("attention-list-button"));

    const list = screen.getByRole("dialog", { name: "Everything that needs attention" });
    expect(within(list).getByRole("region", { name: "Needs-input prompts" })).toHaveTextContent(
      "Pick deployment window",
    );
    expect(within(list).queryByText("Confirm rollback plan")).not.toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /Muted questions/ }));
    const muted = within(list).getByRole("region", { name: "Muted questions" });
    expect(muted).toHaveTextContent("Confirm rollback plan");
    expect(within(list).getAllByText("Confirm rollback plan")).toHaveLength(1);
  });

  it("stops quest badge polling while the tab is hidden", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    try {
      render(<TopBar />);
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(1);

      visibilityState = "visible";
      fireEvent(document, new Event("visibilitychange"));
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(storeState.refreshQuestSummary).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows session number next to the session name in the title area", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Main Session"]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, sessionNum: 111, name: "Main Session" }],
    });

    render(<TopBar />);
    expect(screen.getByText("#111")).toBeInTheDocument();
    expect(screen.getByText("Main Session")).toBeInTheDocument();
  });

  it("keeps the leader identity compact in the TopBar", () => {
    // The TopBar already pairs the session number with the leader profile and
    // name, so it must not duplicate the quest-banner role chip treatment.
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Coordinator Session"]]),
      sdkSessions: [
        { sessionId: "s1", createdAt: 1, sessionNum: 111, name: "Coordinator Session", isOrchestrator: true },
      ],
    });

    render(<TopBar />);

    const identityButton = screen.getByRole("button", { name: "Leader #111 Coordinator Session" });
    expect(identityButton).toHaveTextContent("#111Coordinator Session");
    expect(identityButton).not.toHaveTextContent("Leader");
    expect(screen.queryByTestId("topbar-leader-session-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-role-icon-leader")).not.toBeInTheDocument();
  });

  // Diffs open from the quest banner chip now (see DiffChip); the top bar must not bring back a Diff
  // button whose changed-file count reads like an unread badge.
  it("has no Diff button in leader quest routes even when the quest has commits and changes", () => {
    window.location.hash = "#/session/s1?thread=q-42";
    resetStore({
      currentSessionId: "s1",
      sessions: new Map([
        ["s1", { cwd: "/repo/leader", isOrchestrator: true }],
        ["worker", { cwd: "/repo/worker" }],
      ]),
      sdkSessions: [
        { sessionId: "s1", createdAt: 1, sessionNum: 111, name: "Leader Session", isOrchestrator: true },
        { sessionId: "worker", createdAt: 2, sessionNum: 222, name: "Worker Session", cwd: "/repo/worker" },
      ],
      sessionBoards: new Map([["s1", [{ questId: "q-42", status: "IMPLEMENTING", updatedAt: 1, worker: "worker" }]]]),
      quests: [
        {
          id: "q-42-v1",
          questId: "q-42",
          version: 1,
          title: "Recorded commits",
          status: "in_progress",
          description: "Recorded commit fixture.",
          createdAt: 1,
          sessionId: "worker",
          claimedAt: 1,
          commitShas: ["abc1234", "def5678"],
        } as any,
      ],
      changedFiles: new Map([
        ["s1", new Set(["/repo/leader/leader.ts"])],
        ["worker", new Set(["/repo/worker/changed.ts", "/repo/worker/other.ts"])],
      ]),
    });

    render(<TopBar />);

    expect(screen.queryByRole("button", { name: /diff|recorded commits|changes/i })).not.toBeInTheDocument();
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("has no Diff button in non-leader sessions with changed files", () => {
    resetStore({
      currentSessionId: "worker",
      sessions: new Map([["worker", { cwd: "/repo/worker" }]]),
      sdkSessions: [
        { sessionId: "worker", createdAt: 2, sessionNum: 222, name: "Worker Session", cwd: "/repo/worker" },
      ],
      changedFiles: new Map([["worker", new Set(["/repo/worker/changed.ts"])]]),
    });

    render(<TopBar />);

    expect(screen.queryByRole("button", { name: /diff|changes/i })).not.toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("opens the current session panel from the top bar", () => {
    window.location.hash = "#/session/s1";
    resetStore({
      currentSessionId: "s1",
      taskPanelOpen: false,
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, name: "Main Session", cliConnected: true, state: "connected" }],
    });

    render(<TopBar />);

    const panelButton = screen.getByRole("button", { name: "Open session panel" });
    expect(panelButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(panelButton);

    expect(storeState.setTaskPanelOpen).toHaveBeenCalledWith(true);
  });

  it("closes the current session panel from the active top bar toggle", () => {
    window.location.hash = "#/session/s1";
    resetStore({
      currentSessionId: "s1",
      taskPanelOpen: true,
      sessions: new Map([["s1", { cwd: "/repo" }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, name: "Main Session", cliConnected: true, state: "connected" }],
    });

    render(<TopBar />);

    const panelButton = screen.getByRole("button", { name: "Close session panel" });
    expect(panelButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(panelButton);

    expect(storeState.setTaskPanelOpen).toHaveBeenCalledWith(false);
  });

  it("shows a leader portrait before the leader session name and routes it to session info", async () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Leader Session"]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 111,
          name: "Leader Session",
          isOrchestrator: true,
          leaderProfilePortrait: {
            id: "tako1-01",
            poolId: "tako",
            label: "Tako 1.1",
            smallUrl: "/leader-profile-portraits/tako/tako1-01.v2.96.webp",
            largeUrl: "/leader-profile-portraits/tako/tako1-01.v2.320.webp",
            smallSize: 96,
            largeSize: 320,
            smallBytes: 2912,
            largeBytes: 19216,
          },
        },
      ],
    });

    render(<TopBar />);
    const portrait = screen.getByTestId("topbar-leader-profile-portrait");
    expect(portrait).toBeInTheDocument();
    expect(portrait).toHaveAttribute("width", "96");
    expect(portrait).toHaveAttribute("height", "96");
    expect(portrait).toHaveAttribute("loading", "eager");
    expect(portrait).toHaveAttribute("decoding", "async");
    expect(screen.getByText("Leader Session")).toBeInTheDocument();

    fireEvent.click(portrait);

    expect(screen.queryByRole("dialog", { name: "Leader profile" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("session-info-popover")).toHaveAttribute("data-anchor-present", "true");
    });
  });

  it("opens Configure Session from Session Info in the global modal layer", async () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            cwd: "/repo",
            backend_type: "codex",
            model: "gpt-5.4",
            permissionMode: "codex-default",
            codex_service_tier: null,
          },
        ],
      ]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 1533,
          name: "Codex Session",
          backendType: "codex",
          model: "gpt-5.4",
          permissionMode: "codex-default",
        },
      ],
    });

    render(<TopBar />);
    fireEvent.click(screen.getByText("Codex Session"));

    await waitFor(() => expect(screen.getByTestId("session-info-popover")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("mock-session-info-configure"));

    const dialog = await screen.findByRole("dialog", { name: "Configure Session" });
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.queryByTestId("session-info-popover")).not.toBeInTheDocument();
  });

  it("does not show a duplicate plan/agent mode label in title bar", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "plan", backend_type: "codex" }]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 111,
          name: "Main Session",
          permissionMode: "plan",
          backendType: "codex",
        },
      ],
    });

    render(<TopBar />);
    expect(screen.queryByTitle("Current mode: Plan")).not.toBeInTheDocument();
  });

  // The Board button is the leader's way into the work board from any thread. It replaced the
  // wide-desktop-only Workboard and Completed shortcuts, and shows one phase-colored dot per
  // quest in a Journey phase instead of a count: a count or corner badge read as unread and nagged.
  it("shows a Board button with one phase dot per quest in a Journey phase, and the counts in its label", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([
        [
          "s1",
          [
            { questId: "q-1", status: "WORKING", updatedAt: 1 },
            { questId: "q-4", status: "MEMORY", updatedAt: 4 },
            // Queued and proposed quests are not being worked on, so they get no dot.
            { questId: "q-3", status: "QUEUED", updatedAt: 3 },
            { questId: "q-5", status: "PROPOSED", updatedAt: 5 },
          ],
        ],
      ]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
    });

    render(<TopBar />);

    const button = screen.getByTestId("topbar-workboard-button");
    expect(button).toHaveTextContent(/^Board$/);
    expect(screen.getByTestId("workboard-dots-icon")).toHaveAttribute("data-dot-count", "2");
    expect(screen.getAllByTestId("workboard-dot").map((dot) => dot.getAttribute("data-phase"))).toEqual([
      "memory",
      "work",
    ]);
    expect(button).toHaveAccessibleName("Open work board: 2 active (1 Memory, 1 Work)");
    expect(button).toHaveAttribute("title", "Open work board: 2 active (1 Memory, 1 Work)");
    // No count or phase-summary text: the width must not change with the board.
    expect(screen.queryByTestId("topbar-workboard-count")).not.toBeInTheDocument();
    expect(screen.queryByTestId("topbar-workboard-phase-summary")).not.toBeInTheDocument();
    // The retired separate shortcuts must not come back next to the Board button.
    expect(screen.queryByTestId("topbar-workboard-shortcut")).not.toBeInTheDocument();
    expect(screen.queryByTestId("topbar-completed-shortcut")).not.toBeInTheDocument();
  });

  it("keeps the Board button for a leader whose board is empty", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
    });

    render(<TopBar />);

    expect(screen.getByTestId("topbar-workboard-button")).toHaveAccessibleName("Open work board: nothing active");
    expect(screen.queryAllByTestId("workboard-dot")).toHaveLength(0);
  });

  it("shows only the dot board on a phone, with three dots and +N past five", () => {
    window.innerWidth = 430;
    const rows = Array.from({ length: 7 }, (_, index) => ({
      questId: `q-${index + 1}`,
      status: "WORKING",
      updatedAt: index + 1,
    }));
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", rows]]),
    });

    render(<TopBar />);

    const button = screen.getByTestId("topbar-workboard-button");
    expect(button).not.toHaveTextContent("Board");
    expect(button).toHaveAccessibleName("Open work board: 7 active (7 Work)");
    expect(screen.getAllByTestId("workboard-dot")).toHaveLength(3);
    expect(screen.getByTestId("workboard-dots-overflow")).toHaveTextContent("+4");
  });

  it("places the Board button before Next and the session controls", () => {
    resetStore({
      sdkSessions: [
        { sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" },
        { sessionId: "s2", createdAt: 2, name: "Worker Session", sessionNum: 12 },
      ],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionNotifications: new Map([
        [
          "s2",
          [{ id: "n-1", category: "needs-input", summary: "Need scope", timestamp: 3, messageId: "m1", done: false }],
        ],
      ]),
    });

    render(<TopBar />);

    const board = screen.getByTestId("topbar-workboard-button");
    // The bell and search moved to the sessions panel; the attention list now leads the session controls.
    const next = screen.getByTestId("attention-list-button");
    expect(board.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the board in place without routing away from the current thread", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
    });
    window.location.hash = "#/session/s1?thread=q-1";

    render(<TopBar />);

    fireEvent.click(screen.getByTestId("topbar-workboard-button"));
    expect(storeState.setLeaderWorkboardView).toHaveBeenLastCalledWith("s1", "active");
    expect(window.location.hash).toBe("#/session/s1?thread=q-1");
  });

  it("opens completed quests when the active board is empty but completed quests exist", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
    });

    render(<TopBar />);

    fireEvent.click(screen.getByTestId("topbar-workboard-button"));
    expect(storeState.setLeaderWorkboardView).toHaveBeenLastCalledWith("s1", "completed");
  });

  it.each(["active", "completed", "other"] as const)("closes the board when it is open on the %s view", (openView) => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      leaderWorkboardViews: new Map([["s1", openView]]),
    });

    render(<TopBar />);

    const button = screen.getByTestId("topbar-workboard-button");
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(storeState.setLeaderWorkboardView).toHaveBeenLastCalledWith("s1", null);
  });

  it("opens the active panel in place from a quest thread", () => {
    resetStore({
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: true, name: "Leader Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
      ...leaderProjectionState(),
    });
    window.location.hash = "#/session/s1?thread=q-1";

    const view = render(
      <>
        <TopBar />
        <WorkBoardBar sessionId="s1" currentThreadKey="q-1" />
      </>,
    );

    expect(screen.queryByTestId("workboard-main-banner")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("topbar-workboard-button"));

    expect(window.location.hash).toBe("#/session/s1?thread=q-1");
    view.unmount();
    render(
      <>
        <TopBar />
        <WorkBoardBar sessionId="s1" currentThreadKey="q-1" />
      </>,
    );
    expect(screen.queryByTestId("workboard-main-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("workboard-panel")).toHaveAttribute("data-view", "active");
    // Outside Main the banner's view buttons are hidden, so the panel brings its own switch.
    expect(screen.getByTestId("workboard-panel-header")).toBeInTheDocument();
    expect(screen.getByTestId("workboard-panel-completed-button")).toBeInTheDocument();
  });

  it("does not let stale bridge role state revive the Board button for a canonical worker row", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", isOrchestrator: true }]]),
      sdkSessions: [{ sessionId: "s1", createdAt: 1, isOrchestrator: false, name: "Worker Session" }],
      sessionBoards: new Map([["s1", [{ questId: "q-1", status: "IMPLEMENTING", updatedAt: 1 }]]]),
      sessionCompletedBoards: new Map([["s1", [{ questId: "q-2", status: "DONE", updatedAt: 2, completedAt: 2 }]]]),
    });

    render(<TopBar />);

    expect(screen.queryByTestId("topbar-workboard-button")).not.toBeInTheDocument();
  });

  it("shows checked quest marker from SDK metadata for a selected snapshot-only session", () => {
    // Direct navigation to an archived/exited session may render the title from
    // the /api/sessions snapshot before any live session state exists.
    resetStore({
      currentSessionId: "archived-worker",
      sessions: new Map(),
      cliConnected: new Map([["archived-worker", false]]),
      sessionStatus: new Map(),
      sessionNames: new Map([["archived-worker", "Use active leader thread tab as voice transcription context"]]),
      questNamedSessions: new Set(["archived-worker"]),
      sdkSessions: [
        {
          sessionId: "archived-worker",
          createdAt: 1,
          archived: true,
          state: "exited",
          sessionNum: 1544,
          name: "Use active leader thread tab as voice transcription context",
          claimedQuestStatus: "done",
          claimedQuestVerificationInboxUnread: true,
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByText("☑ Use active leader thread tab as voice transcription context")).toBeInTheDocument();
  });

  it("preserves incomplete quest marker for selected in-progress SDK sessions", () => {
    resetStore({
      currentSessionId: "worker",
      sessions: new Map(),
      cliConnected: new Map([["worker", true]]),
      sessionNames: new Map([["worker", "Fix stale quest completion status in session sidebar titles"]]),
      questNamedSessions: new Set(["worker"]),
      sdkSessions: [
        {
          sessionId: "worker",
          createdAt: 1,
          state: "connected",
          sessionNum: 1550,
          name: "Fix stale quest completion status in session sidebar titles",
          claimedQuestStatus: "in_progress",
        },
      ],
    });

    render(<TopBar />);

    expect(screen.getByText("☐ Fix stale quest completion status in session sidebar titles")).toBeInTheDocument();
  });

  it("publishes opened session info panel id for sidebar-linked highlights", async () => {
    render(<TopBar />);

    fireEvent.click(screen.getByRole("button", { name: /session s1/i }));
    await waitFor(() => {
      expect(storeState.setSessionInfoOpenSessionId).toHaveBeenLastCalledWith("s1");
    });

    fireEvent.click(screen.getByRole("button", { name: /session s1/i }));
    await waitFor(() => {
      expect(storeState.setSessionInfoOpenSessionId).toHaveBeenLastCalledWith(null);
    });
  });

  it("ignores the removed browser-only session info section event", () => {
    render(<TopBar />);

    // A stale page or extension may still dispatch the old event; without the
    // editor there must be no empty popover shell or retained section anchor.
    window.dispatchEvent(
      new CustomEvent("takode:open-session-info", {
        detail: { sessionId: "s1", section: "codex-goal" },
      }),
    );

    expect(screen.queryByTestId("session-info-popover")).not.toBeInTheDocument();
    expect(storeState.setSessionInfoOpenSessionId).not.toHaveBeenCalledWith("s1");
  });

  it("removes the duplicate title-bar copy and right-side session info buttons", () => {
    resetStore({
      sessions: new Map([["s1", { cwd: "/repo", permissionMode: "acceptEdits", backend_type: "claude" }]]),
      sessionNames: new Map([["s1", "Main Session"]]),
      sdkSessions: [
        {
          sessionId: "s1",
          createdAt: 1,
          sessionNum: 111,
          name: "Main Session",
          cliSessionId: "cli-session-123",
        },
      ],
    });

    render(<TopBar />);

    expect(screen.queryByTitle(/Copy CLI Session ID/)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Session info")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /main session/i })).toBeInTheDocument();
  });

  it("shows the enabled search shortcut in the hover title", () => {
    resetStore({
      shortcutSettings: { enabled: true, preset: "standard", overrides: {} },
    });

    render(<TopBar fullPageLabel="Quests" />);
    expect(screen.getByTitle("Universal Search (Ctrl+Shift+F)")).toBeInTheDocument();
  });

  it("opens the single app-level Universal Search affordance", () => {
    // Full-page headers keep one control for the shared Universal Search/Recent modal;
    // session views open it from the sessions panel instead.
    const onOpenUniversalSearch = vi.fn();

    render(<TopBar fullPageLabel="Quests" onOpenUniversalSearch={onOpenUniversalSearch} />);

    expect(screen.queryByRole("button", { name: "Open Recent asks" })).toBeNull();
    expect(screen.getAllByTestId("topbar-universal-search")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Universal Search" }));
    expect(onOpenUniversalSearch).toHaveBeenCalledTimes(1);
  });
  it("keeps session-local Codex subagent access out of the global top bar", () => {
    resetStore({
      sessions: new Map([
        [
          "s1",
          {
            cwd: "/repo",
            backend_type: "codex",
            codex_native_subagents: {
              revision: 3,
              coverage: "partial",
              session: { total: 5, statusCounts: {}, activeCount: 2, unresolvedCount: 1 },
              children: [],
              turns: {},
            },
          },
        ],
      ]),
    });

    render(<TopBar />);

    expect(screen.queryByTestId("topbar-codex-subagents")).toBeNull();
    expect(screen.queryByRole("button", { name: /Codex subagents/i })).toBeNull();
  });
});

describe("TopBar phone layout and Next", () => {
  function twoPromptsState(): Partial<MockStoreState> {
    return {
      sessionNotifications: new Map([
        [
          "s1",
          [{ id: "n-1", category: "needs-input", summary: "Pick deployment window", timestamp: 1, messageId: "m1" }],
        ],
        [
          "s2",
          [{ id: "n-2", category: "needs-input", summary: "Confirm rollback plan", timestamp: 2, messageId: "m2" }],
        ],
      ]),
      sdkSessions: [
        { sessionId: "s1", createdAt: 10, sessionNum: 101, name: "Worker One" },
        { sessionId: "s2", createdAt: 20, sessionNum: 102, name: "Worker Two" },
      ],
    };
  }

  it("keeps only the sidebar toggle, title and the attention list on a phone", () => {
    // The phone bar was too crowded to show the title. Search and Quests live in the
    // sessions panel, and the attention list covers needs input and Notify Me, so ≡
    // carries no waiting dot. Diffs open from the quest banner chip, so no Diff button either.
    window.innerWidth = 430;
    resetStore({ ...twoPromptsState(), sidebarOpen: false });
    render(<TopBar />);

    expect(screen.getByText("Worker One")).toBeInTheDocument();
    expect(screen.getByText("#101")).toBeInTheDocument();
    expect(screen.getByTestId("attention-list-button")).toHaveTextContent("2");
    expect(screen.queryByRole("button", { name: /diff/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("topbar-universal-search")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Quests")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /needs-input notifications across sessions/ })).not.toBeInTheDocument();
  });

  it("opens a list of everything needing attention, whose Next walks it from the newest prompt", () => {
    // The top-right control is a list toggle now: it shows every item with its
    // session, and Next inside it steps through the list instead of jumping blind.
    resetStore(twoPromptsState());
    render(<TopBar />);

    // Desktop matches the phone: the attention list stands in for the needs-input and Notify Me counts.
    const pill = screen.getByTestId("attention-list-button");
    expect(pill).toHaveTextContent("2");
    expect(screen.queryByRole("button", { name: /needs-input notifications across sessions/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("topbar-universal-search")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Quests")).not.toBeInTheDocument();

    fireEvent.click(pill);
    expect(window.location.hash).not.toContain("m2");
    const panel = screen.getByRole("dialog", { name: "Everything that needs attention" });
    const rows = within(panel).getAllByTestId("attention-item-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Confirm rollback plan"),
      expect.stringContaining("Pick deployment window"),
    ]);
    expect(rows[0]).toHaveTextContent("#102 Worker Two");

    fireEvent.click(within(panel).getByTestId("attention-list-next"));
    expect(window.location.hash).toContain("m2");
    expect(screen.getByTestId("next-attention-toast")).toHaveTextContent("Needs input · #102 Confirm rollback plan");
    expect(screen.getByTestId("next-attention-toast")).toHaveTextContent("1 / 2");
    expect(within(panel).getByTestId("attention-list-next")).toHaveTextContent("2/2");

    fireEvent.click(within(panel).getByTestId("attention-list-next"));
    expect(window.location.hash).toContain("m1");
    expect(screen.getByTestId("next-attention-toast")).toHaveTextContent("2 / 2");
  });

  it("names a prompt's quest on its second line and falls back to the session name", () => {
    // The user asked for the quest a question belongs to instead of the session
    // name, keeping the session number and age; prompts outside a quest thread
    // still show the session.
    resetStore({
      ...twoPromptsState(),
      quests: [{ questId: "q-12", title: "Make offline hosts obvious", status: "in_progress" } as never],
      sessionNotifications: new Map([
        [
          "s1",
          [
            {
              id: "n-1",
              category: "needs-input",
              summary: "Pick a chip style",
              timestamp: 1,
              messageId: "m1",
              threadKey: "q-12",
              questId: "q-12",
            },
          ],
        ],
        [
          "s2",
          [{ id: "n-2", category: "needs-input", summary: "Confirm rollback plan", timestamp: 2, messageId: "m2" }],
        ],
      ]),
    });
    render(<TopBar />);
    fireEvent.click(screen.getByTestId("attention-list-button"));

    const places = within(screen.getByRole("dialog", { name: "Everything that needs attention" }))
      .getAllByTestId("attention-item-place")
      .map((place) => place.textContent);
    expect(places[0]).toMatch(/^#102 Worker Two· /);
    expect(places[1]).toMatch(/^q-12 Make offline hosts obvious· #101 · /);
    expect(places[1]).not.toContain("Worker One");
  });

  it("keeps only Go to on rows and offers the prompt actions in a row menu that leaves the list open", () => {
    resetStore(twoPromptsState());
    render(<TopBar />);
    fireEvent.click(screen.getByTestId("attention-list-button"));
    const panel = screen.getByRole("dialog", { name: "Everything that needs attention" });
    const row = within(panel).getAllByTestId("attention-item-row")[0]!;
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Go to"]);

    fireEvent.contextMenu(row);
    const mute = screen.getByRole("button", { name: "Mute" });
    expect(screen.getByRole("button", { name: "Remind me later" })).toBeInTheDocument();
    // The menu is portaled outside the list; pressing it must not count as clicking outside the list.
    fireEvent.pointerDown(mute);
    expect(screen.getByRole("dialog", { name: "Everything that needs attention" })).toBeInTheDocument();
  });

  it("names Main as the thread for a leader's Main prompt, keeping the session number", () => {
    // Leaders have thread tabs, so their Main prompts name Main; sessions
    // without tabs keep the session name (covered above).
    resetStore({
      ...twoPromptsState(),
      sdkSessions: [
        { sessionId: "s1", createdAt: 10, sessionNum: 101, name: "Worker One" },
        { sessionId: "s2", createdAt: 20, sessionNum: 102, name: "Leader Two", isOrchestrator: true },
      ],
    });
    render(<TopBar />);
    fireEvent.click(screen.getByTestId("attention-list-button"));
    const places = within(screen.getByRole("dialog", { name: "Everything that needs attention" }))
      .getAllByTestId("attention-item-place")
      .map((place) => place.textContent);
    expect(places[0]).toMatch(/^Main· #102 · /);
    expect(places[1]).toMatch(/^#101 Worker One· /);
  });

  it("opens one item from the list with Go to and closes the list", () => {
    resetStore(twoPromptsState());
    render(<TopBar />);

    fireEvent.click(screen.getByTestId("attention-list-button"));
    fireEvent.click(screen.getByRole("button", { name: "Go to Pick deployment window" }));
    expect(window.location.hash).toContain("m1");
    expect(screen.queryByRole("dialog", { name: "Everything that needs attention" })).not.toBeInTheDocument();
  });

  it("steps to the next item from the keyboard shortcut without opening the list", () => {
    resetStore(twoPromptsState());
    render(<TopBar />);

    act(() => {
      window.dispatchEvent(new Event(ATTENTION_NEXT_EVENT));
    });
    expect(window.location.hash).toContain("m2");
    expect(screen.getByTestId("next-attention-toast")).toHaveTextContent("1 / 2");
  });

  it("leaves a herded worker's question to its leader out of the list", () => {
    // A worker asking its leader is not the user's to answer; only s1's prompt counts.
    resetStore({
      ...twoPromptsState(),
      sdkSessions: [
        { sessionId: "s1", createdAt: 10, sessionNum: 101, name: "Worker One" },
        { sessionId: "s2", createdAt: 20, sessionNum: 102, name: "Worker Two", herdedBy: "leader-1" },
      ],
    });
    render(<TopBar />);

    expect(screen.getByTestId("attention-list-button")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("attention-list-button"));
    fireEvent.click(screen.getByTestId("attention-list-next"));
    expect(screen.getByTestId("next-attention-toast")).toHaveTextContent("#101 Pick deployment window");
  });

  it("counts only the open questions while one waits, and everything once none do", () => {
    // Amber with the total of prompts and unreads looked like many questions when
    // only one needed an answer. The list it opens still holds every item.
    const withUnread: Partial<MockStoreState> = {
      ...twoPromptsState(),
      sdkSessions: [
        ...twoPromptsState().sdkSessions!,
        { sessionId: "s3", createdAt: 30, sessionNum: 103, name: "Done One" },
        { sessionId: "s4", createdAt: 40, sessionNum: 104, name: "Done Two" },
      ],
      sessionAttention: new Map([
        ["s3", "review"],
        ["s4", "review"],
      ]),
    };
    resetStore(withUnread);
    const { unmount } = render(<TopBar />);

    const pill = screen.getByTestId("attention-list-button");
    expect(pill).toHaveTextContent(/^2$/);
    expect(pill).toHaveAccessibleName("Everything that needs attention (2 questions open)");
    fireEvent.click(pill);
    expect(
      within(screen.getByRole("dialog", { name: "Everything that needs attention" })).getAllByTestId(
        "attention-item-row",
      ),
    ).toHaveLength(4);
    unmount();

    // With the prompts answered, the pill counts the unread results as before.
    resetStore({ ...withUnread, sessionNotifications: new Map() });
    render(<TopBar />);
    expect(screen.getByTestId("attention-list-button")).toHaveTextContent(/^2$/);
    expect(screen.getByTestId("attention-list-button")).toHaveAccessibleName("Everything that needs attention (2)");
  });

  it("hides Next while nothing needs attention", () => {
    render(<TopBar />);
    expect(screen.queryByTestId("attention-list-button")).not.toBeInTheDocument();
  });
});

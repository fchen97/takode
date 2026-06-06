import { usePendingAction } from "../hooks/usePendingAction.js";
import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { SessionStatusDot } from "./SessionStatusDot.js";
import { parseHash, secondaryPageFromHash } from "../utils/routing.js";
import { toggleSecondaryPage } from "../utils/secondary-view.js";
import { SessionInfoPopover } from "./SessionInfoPopover.js";
import { useSessionSettings } from "./SessionSettingsMenu.js";
import { ConfigureSessionModal } from "./ConfigureSessionModal.js";
import { resolveSessionNavigation } from "../utils/session-navigation-resolver.js";
import { hasUnreadSessionAttention } from "../utils/session-attention-status.js";
import { questLabel, questOwnsSessionName } from "../utils/quest-helpers.js";
import { getShortcutTitle } from "../shortcuts.js";
import { activeBoardPhaseDots } from "./leader-board-summary.js";
import { LeaderWorkboardTopBarButton } from "./leader-workboard-controls.js";
import type { BoardRowData } from "./BoardTable.js";
import { SessionContextMenu, type SessionMenuTarget } from "./SessionContextMenu.js";
import { LONG_PRESS_TARGET_CLASS, useLongPress } from "../hooks/useLongPress.js";
import { SessionArchiveConfirmation } from "./SessionArchiveConfirmation.js";
import { ContextMenu } from "./ContextMenu.js";
import { useSessionActions } from "../hooks/useSessionActions.js";
import { SessionHostBadge } from "./HostBadge.js";
import { GlobalAttentionMenu } from "./GlobalAttentionMenu.js";
import { useDesktopShellLayout } from "../hooks/useDesktopShellLayout.js";

type TopBarState = ReturnType<typeof useStore.getState>;
const EMPTY_LEADER_BOARD_ROWS: readonly BoardRowData[] = [];

interface TopBarProps {
  fullPageLabel?: string;
  universalSearchOpen?: boolean;
  onOpenUniversalSearch?: () => void;
  onCloseUniversalSearch?: () => void;
}

export function getCurrentTopBarSessionState(state: TopBarState) {
  const currentSessionId = state.currentSessionId;
  if (!currentSessionId) {
    return {
      currentSessionId: null,
      isConnected: false,
      status: null,
      currentPermCount: 0,
      currentSdkState: null,
      isArchived: false,
      currentHasUnread: false,
      sessionName: null,
      sessionNum: null,
      isQuestNamed: false,
      questStatus: undefined,
      idleKilled: false,
      activeTimerCount: 0,
      waits: null,
      leaderProfilePortrait: undefined,
      pause: null,
      paused: false,
    };
  }

  const resolved = resolveSessionNavigation(state, currentSessionId);
  const currentSessionVm = resolved?.viewModel ?? null;
  const currentItem = resolved?.sidebarItem;
  const questStatus = currentSessionVm?.claimedQuestStatus;
  const questReviewInboxUnread = currentSessionVm?.claimedQuestVerificationInboxUnread;
  const sessionName = resolved?.sidebarItem.name || `Session ${currentSessionId.slice(0, 8)}`;

  return {
    currentSessionId,
    isConnected: currentItem?.isConnected ?? false,
    status: currentItem?.status ?? null,
    currentPermCount: currentItem?.permCount ?? 0,
    currentSdkState: currentItem?.sdkState ?? null,
    isArchived: currentItem?.archived ?? false,
    currentHasUnread: hasUnreadSessionAttention(state.sessionAttention.get(currentSessionId)),
    sessionName,
    sessionNum: currentSessionVm?.sessionNum ?? null,
    isQuestNamed:
      currentSessionVm?.isOrchestrator !== true && questOwnsSessionName(questStatus, questReviewInboxUnread),
    questStatus,
    questReviewInboxUnread,
    idleKilled: currentItem?.idleKilled ?? false,
    activeTimerCount: currentItem?.pendingTimerCount ?? 0,
    waits: currentItem?.waits ?? null,
    leaderProfilePortrait: currentItem?.isOrchestrator ? currentItem.leaderProfilePortrait : undefined,
    pause: currentSessionVm?.pause ?? null,
    paused: currentItem?.paused ?? !!currentSessionVm?.pause?.pausedAt,
  };
}

export function TopBar({
  fullPageLabel,
  universalSearchOpen = false,
  onOpenUniversalSearch = () => {},
  onCloseUniversalSearch = () => {},
}: TopBarProps = {}) {
  const hash = useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  const route = useMemo(() => parseHash(hash), [hash]);
  const isSessionView = route.page === "session" || route.page === "home";
  const isQuestmasterPage = secondaryPageFromHash(hash) === "questmaster";
  // The phone shell moves Needs input, Notify Me, Search and Quests into the sessions panel.
  const compact = !useDesktopShellLayout();
  const {
    currentSessionId,
    sidebarOpen,
    shortcutSettings,
    setSidebarOpen,
    setSessionInfoOpenSessionId,
    codexSubagentInspector,
    closeCodexSubagentInspector,
    activeQuestCount,
    refreshQuestSummary,
    isCurrentLeaderSession,
    currentLeaderBoard,
    currentLeaderWorkboardView,
    taskPanelOpen,
    setLeaderWorkboardView,
    setTaskPanelOpen,
  } = useStore(
    useShallow((s) => ({
      currentSessionId: s.currentSessionId,
      sidebarOpen: s.sidebarOpen,
      shortcutSettings: s.shortcutSettings,
      setSidebarOpen: s.setSidebarOpen,
      setSessionInfoOpenSessionId: s.setSessionInfoOpenSessionId,
      codexSubagentInspector: s.codexSubagentInspector,
      closeCodexSubagentInspector: s.closeCodexSubagentInspector,
      activeQuestCount:
        s.questSummary?.active ?? s.quests.reduce((count, quest) => count + (quest.status !== "done" ? 1 : 0), 0),
      refreshQuestSummary: s.refreshQuestSummary,
      isCurrentLeaderSession:
        !!s.currentSessionId &&
        s.sdkSessions.some((session) => session.sessionId === s.currentSessionId && session.isOrchestrator === true),
      currentLeaderBoard: s.currentSessionId
        ? (s.sessionBoards.get(s.currentSessionId) ?? EMPTY_LEADER_BOARD_ROWS)
        : EMPTY_LEADER_BOARD_ROWS,
      currentLeaderWorkboardView: s.currentSessionId ? (s.leaderWorkboardViews.get(s.currentSessionId) ?? null) : null,
      taskPanelOpen: s.taskPanelOpen,
      setLeaderWorkboardView: s.setLeaderWorkboardView,
      setTaskPanelOpen: s.setTaskPanelOpen,
    })),
  );
  const {
    isConnected,
    status,
    currentPermCount,
    currentSdkState,
    isArchived,
    currentHasUnread,
    sessionName,
    sessionNum,
    isQuestNamed,
    questStatus,
    questReviewInboxUnread,
    idleKilled,
    activeTimerCount,
    waits,
    leaderProfilePortrait,
    paused,
  } = useStore(useShallow(getCurrentTopBarSessionState));
  const [infoOpen, setInfoOpen] = useState(false);
  const [configureSessionId, setConfigureSessionId] = useState<string | null>(null);
  const [sessionMenu, setSessionMenu] = useState<SessionMenuTarget | null>(null);
  const [renamingSession, setRenamingSession] = useState<{ sessionId: string; name: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const sessionMenuPosition = useRef({ x: 0, y: 0 });
  const sessionActions = useSessionActions();
  const reconnect = usePendingAction("Reconnect failed.");
  const { cancelArchive } = sessionActions;
  // Long-press on touch, right-click on desktop.
  const sessionTitleLongPress = useLongPress(
    currentSessionId
      ? (x, y) => {
          setInfoOpen(false);
          sessionMenuPosition.current = { x, y };
          setSessionMenu({ sessionId: currentSessionId, x, y });
        }
      : undefined,
  );
  const sessionInfoAnchorRef = useRef<HTMLDivElement | null>(null);
  const shortcutPlatform = typeof navigator === "undefined" ? undefined : navigator.platform;
  const isPaused = paused;
  const currentLeaderPhaseDots = useMemo(() => activeBoardPhaseDots(currentLeaderBoard), [currentLeaderBoard]);

  const statusDot = (className?: string) => (
    <SessionStatusDot
      permCount={currentPermCount}
      isConnected={isConnected}
      sdkState={currentSdkState}
      status={status}
      hasUnread={currentHasUnread}
      idleKilled={idleKilled}
      activeTimerCount={activeTimerCount}
      waits={waits}
      className={className}
    />
  );

  useEffect(() => {
    setSessionMenu(null);
    setRenamingSession(null);
    cancelArchive();
  }, [currentSessionId, isSessionView, cancelArchive]);

  useEffect(() => {
    if (renamingSession) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingSession?.sessionId]);

  function confirmSessionRename() {
    if (renamingSession?.name.trim()) {
      api.renameSession(renamingSession.sessionId, renamingSession.name.trim()).catch(console.error);
    }
    setRenamingSession(null);
  }

  useEffect(() => {
    if (!isSessionView && codexSubagentInspector) closeCodexSubagentInspector();
  }, [closeCodexSubagentInspector, codexSubagentInspector, isSessionView]);

  useEffect(() => {
    const openSessionId = infoOpen && isSessionView ? currentSessionId : null;
    setSessionInfoOpenSessionId(openSessionId);
    return () => setSessionInfoOpenSessionId(null);
  }, [infoOpen, isSessionView, currentSessionId, setSessionInfoOpenSessionId]);

  // Load quests on mount and keep the badge count fresh. The quest_list_updated
  // WebSocket broadcast only reaches browsers with an active session WS connection,
  // so we also poll and refresh on tab visibility/focus as a fallback.
  useEffect(() => {
    let timeoutId: number | null = null;

    const scheduleNextPoll = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (document.visibilityState !== "visible") return;
      timeoutId = window.setTimeout(() => {
        void refreshQuestSummary();
        scheduleNextPoll();
      }, 15_000);
    };

    void refreshQuestSummary({ force: true });
    scheduleNextPoll();

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        void refreshQuestSummary({ force: true });
        scheduleNextPoll();
      } else if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    }
    function handleFocus() {
      void refreshQuestSummary({ force: true });
      scheduleNextPoll();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [refreshQuestSummary]);

  const handleQuestToggle = useCallback(() => {
    closeCodexSubagentInspector();
    toggleSecondaryPage("questmaster");
  }, [closeCodexSubagentInspector]);
  // Opens the board under the tabs without leaving the current thread; the panel switches views itself.
  const toggleLeaderWorkboardInPlace = useCallback(() => {
    if (!currentSessionId) return;
    const state = useStore.getState();
    if (state.leaderWorkboardViews.get(currentSessionId)) {
      setLeaderWorkboardView(currentSessionId, null);
      return;
    }
    const hasActive = (state.sessionBoards.get(currentSessionId)?.length ?? 0) > 0;
    const hasCompleted = (state.sessionCompletedBoards.get(currentSessionId)?.length ?? 0) > 0;
    setLeaderWorkboardView(currentSessionId, !hasActive && hasCompleted ? "completed" : "active");
  }, [currentSessionId, setLeaderWorkboardView]);

  if (fullPageLabel) {
    return (
      <header className="shrink-0 flex items-center justify-between px-2 sm:px-4 py-2 bg-cc-card border-b border-cc-border">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-cc-muted transition-colors hover:bg-cc-hover hover:text-cc-fg"
            title={getShortcutTitle("Toggle sidebar", shortcutSettings, "toggle_sidebar", shortcutPlatform)}
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path
                fillRule="evenodd"
                d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
                clipRule="evenodd"
              />
            </svg>
          </button>
          <span className="truncate text-[12px] font-semibold text-cc-fg">{fullPageLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[12px] text-cc-muted sm:gap-3">
          <GlobalAttentionMenu compact={compact} />
          <SearchToggleButton
            isOpen={universalSearchOpen}
            onOpen={onOpenUniversalSearch}
            onClose={onCloseUniversalSearch}
          />
          <button
            onClick={handleQuestToggle}
            className={`relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg transition-colors ${
              isQuestmasterPage ? "bg-cc-active text-cc-primary" : "text-cc-muted hover:bg-cc-hover hover:text-cc-fg"
            }`}
            title={isQuestmasterPage ? "Back to session" : "Quests"}
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
              <path d="M2.5 2a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h11a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5h-11zM1 2.5A1.5 1.5 0 012.5 1h11A1.5 1.5 0 0115 2.5v11a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 13.5v-11zM4 5.75a.75.75 0 01.75-.75h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 014 5.75zM4.75 8a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zM4 11.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
            </svg>
            {activeQuestCount > 0 && (
              <span className="absolute -top-1 -right-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-cc-primary px-0.5 text-[8px] font-semibold leading-none text-white">
                {activeQuestCount}
              </span>
            )}
          </button>
        </div>
      </header>
    );
  }

  // Every part of the session identity, settings line included, opens Session Info on a tap and
  // the session menu on a long-press.
  const titleButtonProps = {
    ...sessionTitleLongPress.handlers,
    onClick: () => {
      const nextOpen = !infoOpen;
      setInfoOpen(nextOpen);
      if (nextOpen) closeCodexSubagentInspector();
    },
    style: sessionTitleLongPress.pressStyle,
    className: `cursor-pointer hover:opacity-80 transition-opacity ${LONG_PRESS_TARGET_CLASS}`,
  };
  const titleAriaLabel = [
    isCurrentLeaderSession ? "Leader" : null,
    typeof sessionNum === "number" ? `#${sessionNum}` : null,
    sessionName,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <header
      className={`shrink-0 flex items-center justify-between bg-cc-card border-b border-cc-border ${
        compact ? "gap-2 px-2 py-1.5" : "px-2 sm:px-4 py-2 sm:py-2.5"
      }`}
    >
      <div className={`flex items-center min-w-0 ${compact ? "flex-1 gap-2" : "gap-3"}`}>
        {/* Sidebar toggle */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={`flex items-center justify-center rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer ${
            compact ? "w-9 h-9 shrink-0" : "w-7 h-7"
          }`}
          title={getShortcutTitle("Toggle sidebar", shortcutSettings, "toggle_sidebar", shortcutPlatform)}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {/* Current session status + title — clickable to open session info */}
        {currentSessionId && (
          <div ref={sessionInfoAnchorRef} className={`flex items-center gap-1.5 min-w-0 ${compact ? "flex-1" : ""}`}>
            {renamingSession ? (
              <input
                ref={renameInputRef}
                aria-label="Session name"
                value={renamingSession.name}
                onChange={(e) => setRenamingSession({ ...renamingSession, name: e.target.value })}
                onBlur={confirmSessionRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    confirmSessionRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setRenamingSession(null);
                  }
                  e.stopPropagation();
                }}
                className="min-w-0 w-56 rounded border border-cc-border bg-cc-input-bg px-1 text-[11px] text-cc-fg"
              />
            ) : (
              <>
                {compact ? (
                  // Phone: status dot on the portrait, title on its own line, then #N, host and the
                  // settings line. Every part opens Session Info, which starts with the settings.
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden="true"
                      {...titleButtonProps}
                      className={`shrink-0 ${titleButtonProps.className}`}
                    >
                      <span className="relative shrink-0">
                        {leaderProfilePortrait ? (
                          <>
                            <img
                              src={leaderProfilePortrait.smallUrl}
                              alt=""
                              width={leaderProfilePortrait.smallSize}
                              height={leaderProfilePortrait.smallSize}
                              loading="eager"
                              decoding="async"
                              data-testid="topbar-leader-profile-portrait"
                              className="h-8 w-8 rounded-full object-cover ring-1 ring-cc-border/70"
                              draggable={false}
                            />
                            <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full bg-cc-card p-px">
                              {statusDot("mt-0")}
                            </span>
                          </>
                        ) : (
                          statusDot("mt-0")
                        )}
                      </span>
                    </button>
                    <span className="flex min-w-0 flex-1 flex-col items-start">
                      <button
                        type="button"
                        {...titleButtonProps}
                        aria-label={titleAriaLabel}
                        className={`flex min-w-0 max-w-full text-left ${titleButtonProps.className}`}
                      >
                        {sessionName && (
                          <span
                            className="min-w-0 truncate text-[13px] font-semibold leading-tight text-cc-fg"
                            title={sessionName}
                          >
                            {questLabel(sessionName, isQuestNamed, questStatus, questReviewInboxUnread)}
                          </span>
                        )}
                      </button>
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        {...titleButtonProps}
                        className={`flex min-w-0 max-w-full items-center gap-1 text-[11px] leading-tight text-cc-muted ${titleButtonProps.className}`}
                      >
                        {typeof sessionNum === "number" && <span className="shrink-0">#{sessionNum}</span>}
                        <SessionHostBadge sessionId={currentSessionId} />
                        <TopBarSettingsSummary sessionId={currentSessionId} />
                      </button>
                    </span>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      {...titleButtonProps}
                      aria-label={titleAriaLabel}
                      className={`flex min-w-0 items-center gap-1.5 ${titleButtonProps.className}`}
                    >
                      <div className="[&>div]:mt-0 shrink-0">{statusDot()}</div>
                      {typeof sessionNum === "number" && (
                        <span
                          className="text-[11px] font-medium text-cc-muted shrink-0"
                          title={`Session #${sessionNum}`}
                        >
                          #{sessionNum}
                        </span>
                      )}
                      {leaderProfilePortrait && (
                        <img
                          src={leaderProfilePortrait.smallUrl}
                          alt=""
                          width={leaderProfilePortrait.smallSize}
                          height={leaderProfilePortrait.smallSize}
                          loading="eager"
                          decoding="async"
                          data-testid="topbar-leader-profile-portrait"
                          className="h-7 w-7 shrink-0 rounded-full object-cover ring-1 ring-cc-border/70"
                          draggable={false}
                        />
                      )}
                      {sessionName && (
                        <span className="min-w-0 truncate text-[11px] font-medium text-cc-fg" title={sessionName}>
                          {questLabel(sessionName, isQuestNamed, questStatus, questReviewInboxUnread)}
                        </span>
                      )}
                      <SessionHostBadge sessionId={currentSessionId} iconOnPhone />
                      <TopBarSettingsSummary sessionId={currentSessionId} />
                    </button>
                  </>
                )}
              </>
            )}
            {!isConnected && !isPaused && !isArchived && (
              <button
                onClick={() => currentSessionId && void reconnect.run(() => api.relaunchSession(currentSessionId))}
                aria-busy={reconnect.pending || undefined}
                className="text-[11px] text-cc-warning hover:text-cc-warning/80 font-medium cursor-pointer hidden sm:inline"
              >
                Reconnect
              </button>
            )}
          </div>
        )}
      </div>

      {/* Right side */}
      <div className={`flex items-center shrink-0 text-[12px] text-cc-muted ${compact ? "gap-1.5" : "gap-2 sm:gap-3"}`}>
        {currentSessionId && isSessionView && isCurrentLeaderSession && (
          <LeaderWorkboardTopBarButton
            open={currentLeaderWorkboardView !== null}
            dots={currentLeaderPhaseDots}
            compact={compact}
            onToggle={toggleLeaderWorkboardInPlace}
          />
        )}
        {/* Search and Quests live in the sessions panel; needs input and Notify Me in the attention list. */}
        <GlobalAttentionMenu compact={compact} />
        {currentSessionId && isSessionView && (
          <>
            {status === "compacting" && (
              <span className="text-cc-warning font-medium animate-pulse">Compacting...</span>
            )}
            {status === "reverting" && <span className="text-cc-warning font-medium animate-pulse">Reverting...</span>}
            {/* Session panel toggle */}
            <button
              onClick={() => setTaskPanelOpen(!taskPanelOpen)}
              className={`relative flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
                taskPanelOpen ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title={taskPanelOpen ? "Close session panel" : "Open session panel"}
              aria-label={taskPanelOpen ? "Close session panel" : "Open session panel"}
              aria-pressed={taskPanelOpen}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
                <path d="M2.5 2A1.5 1.5 0 001 3.5v9A1.5 1.5 0 002.5 14h11a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0013.5 2h-11zM2 3.5a.5.5 0 01.5-.5H10v10H2.5a.5.5 0 01-.5-.5v-9zm9.5 9.5H11V3h2.5a.5.5 0 01.5.5v9a.5.5 0 01-.5.5h-2zM4 5.5a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5zM4 8a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3A.5.5 0 014 8zm.5 2a.5.5 0 000 1h2a.5.5 0 000-1h-2z" />
              </svg>
            </button>
            {infoOpen && currentSessionId && (
              <SessionInfoPopover
                sessionId={currentSessionId}
                onClose={() => setInfoOpen(false)}
                anchorElement={sessionInfoAnchorRef.current}
                onConfigure={(targetSessionId) => {
                  setConfigureSessionId(targetSessionId);
                  setInfoOpen(false);
                }}
              />
            )}
            {configureSessionId && (
              <ConfigureSessionModal sessionId={configureSessionId} onClose={() => setConfigureSessionId(null)} />
            )}
          </>
        )}
      </div>
      <SessionContextMenu
        key={currentSessionId}
        target={sessionMenu}
        onClose={() => setSessionMenu(null)}
        onRename={(sessionId, name) => setRenamingSession({ sessionId, name })}
        actions={sessionActions}
      />
      {sessionActions.archiveConfirmation && (
        <ContextMenu
          {...sessionMenuPosition.current}
          items={[]}
          onClose={sessionActions.cancelArchive}
          widthClassName="w-72 max-w-[calc(100vw-1rem)]"
          footer={
            <SessionArchiveConfirmation
              archiveConfirmation={sessionActions.archiveConfirmation}
              onConfirmArchive={sessionActions.confirmArchive}
              onConfirmArchiveHerdMembers={sessionActions.confirmArchiveHerdMembers}
              onCancelArchive={sessionActions.cancelArchive}
            />
          }
        />
      )}
    </header>
  );
}

function SearchToggleButton({ isOpen, onOpen, onClose }: { isOpen: boolean; onOpen: () => void; onClose: () => void }) {
  const shortcutSettings = useStore((s) => s.shortcutSettings);
  const shortcutPlatform = typeof navigator === "undefined" ? undefined : navigator.platform;

  return (
    <button
      onClick={() => (isOpen ? onClose() : onOpen())}
      aria-label="Universal Search"
      data-testid="topbar-universal-search"
      className={`flex items-center justify-center w-7 h-7 rounded-lg transition-colors cursor-pointer ${
        isOpen ? "text-cc-primary bg-cc-active" : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
      }`}
      title={getShortcutTitle("Universal Search", shortcutSettings, "search_session", shortcutPlatform)}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
        <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.442.156a5 5 0 110-10 5 5 0 010 10z" />
      </svg>
    </button>
  );
}

/** The session's model, effort and access as one label that opens the settings menu. */
/** Model, effort and access as plain text in the title; Session Info changes them. */
function TopBarSettingsSummary({ sessionId }: { sessionId: string }) {
  const settings = useSessionSettings(sessionId);
  if (!settings.summary) return null;
  return (
    <span
      data-testid="session-settings-summary"
      title={settings.title}
      className="min-w-0 truncate text-[11px] font-normal text-cc-muted"
    >
      {settings.summary}
    </span>
  );
}

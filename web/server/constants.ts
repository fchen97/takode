export const DEFAULT_PORT_DEV = 3457;
export const DEFAULT_PORT_PROD = 3456;
export const RESTART_EXIT_CODE = 42;
/** Exit code of a server that found another process holding its state; supervisors must not restart it. */
export const COORDINATOR_SUPERSEDED_EXIT_CODE = 43;
/** Exit code of a server whose coordinator was handed off to another machine; supervisors must not restart it. */
export const COORDINATOR_MOVED_EXIT_CODE = 44;
/** Next-session-number floor in a sessions directory (see `SessionStore.loadSessionNumberFloor`). */
export const SESSION_NUMBERS_FILE = "session-numbers.json";
/** Written in `questmaster-live` once past quest notes carry machine stamps; holds the backup to restore from. */
export const QUEST_MACHINE_STAMPS_MARKER = "machine-stamps.json";
/** Written in a memory repo's `.git` once its past notes carry machine stamps. */
export const MEMORY_MACHINE_STAMPS_MARKER = "takode-machine-stamps.json";
export const GIT_CMD_TIMEOUT = Number(process.env.COMPANION_GIT_TIMEOUT) || 60_000;
/** `git worktree add` writes every file of the repo, which takes minutes for a large one on a slow disk. */
export const GIT_WORKTREE_ADD_TIMEOUT = Math.max(GIT_CMD_TIMEOUT, 600_000);
export const SERVER_GIT_CMD = "git --no-optional-locks -c core.fsmonitor=false";

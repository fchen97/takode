# Running sessions on another machine

One Takode server, the **coordinator**, can run sessions on other machines,
called **hosts**. The coordinator keeps all shared state (sessions, quests,
memory, the board) and serves the browser. A host only runs the session
processes: it runs `takode node`, which connects out to the coordinator, so the
host needs no open inbound ports.

Use this when a project, its data or its hardware lives on another machine,
such as a cloud workspace or a GPU box, and you want its sessions in the same
Takode as everything else.

## Requirements on the host

- A Takode checkout with its dependencies installed:
  `bun install --cwd web --frozen-lockfile`. Keep it at the coordinator's
  commit (see [Updating Takode](#updating-takode)); the coordinator refuses a
  host that speaks an older protocol ("Update takode on the host").
- The agent CLIs its sessions use (`claude`, `codex`), each signed in on that
  machine. Credentials are never copied between machines.
- The project checkouts the sessions will work in.
- Git 2.36 or newer (check with `git --version`). Takode uses Git options that
  older versions lack, such as `git worktree list -z`. Sessions look for tools
  in `~/.local/bin` and the standard system directories (such as
  `/usr/local/bin` and `/usr/bin`) before directories that are only on
  `takode node`'s own `PATH`. So starting the node with a newer Git first on its
  `PATH` is not enough when an older one is installed system-wide: install or
  link the newer one into `~/.local/bin`.

Do not start a Takode server on the host. `takode node` is the only Takode
process it needs.

The host keeps no Takode configuration or data of its own. Settings come from
the coordinator, which stores the ones that differ per machine (such as which
Claude Code and Codex to run) for each host, and the `quest`, `memory` and
`stream` commands of its sessions read and write through the coordinator.
Session processes on the host get `TAKODE_REMOTE_HOST=1`, so these commands
never answer from files the machine may still have under `~/.companion` (for
example from a time it ran its own server); while the coordinator is
unreachable they say so instead. Only facts of the machine stay on it: its
name, its host token, the options `takode node` was started with, and working
checkouts.

Codex sessions get Takode's variables even when the machine's
`~/.codex/config.toml` keeps the environment from commands
(`[shell_environment_policy]` with `inherit = "core"` or `"none"`): the
session's copy of the config passes what that policy passed plus Takode's own
variables, and still nothing else. Codex runs commands in a login shell, which
on some machines resets `PATH`, so `takode node` also puts `quest`, `memory`,
`stream` and `takode` in `~/.local/bin`. A `quest` or `stream` command that
finds no server to ask and no data of its own on the machine fails with an
error instead of creating an empty store.

## Setup

1. **Register the host on the coordinator.** Run `takode host add <name>` or use
   **Settings → Hosts**. The host's token is shown only once. On the
   host, save it to a file only you can read:

   ```bash
   umask 077 && printf '%s' '<token>' > ~/.takode-host-token
   ```

   `takode host remove <name>` revokes the token.

2. **Give the host a way to reach the coordinator's host port.** Besides its
   main port (3456 for production), the coordinator listens on a **host
   port**, its main port plus 1000 (4456 for production; set
   `COMPANION_HOST_LINK_PORT` to choose another). The host port serves only
   callers with a token: the host link and agent CLIs. Point hosts at it, not
   at the main port (see [Shared machines](#shared-machines)). Any of these
   works:
   - an `https://` address that leads to the coordinator's host port;
   - a reverse SSH tunnel opened from the coordinator's machine, so the host
     reaches the coordinator on its own loopback and nothing is exposed to the
     network:

     ```bash
     ssh -R 13456:127.0.0.1:4456 <host>   # 4456 is the coordinator's host port
     ```

     The host then uses `http://127.0.0.1:13456`. `takode node` accepts plain
     `http://` only for loopback addresses (or with `--allow-insecure` when the
     network already encrypts the traffic).
   - a forward tunnel opened from the host, when only the host can connect to
     the coordinator's machine (for example a coordinator in a cloud workspace
     and a laptop as the host): `ssh -L 13456:127.0.0.1:4456 <coordinator>`, or
     the workspace's own port forwarding. The host again uses
     `http://127.0.0.1:13456`. A browser on the host needs a second forward,
     to the main port.

   The coordinator listens on every network interface by default. When it
   should be reachable only through tunnels, start it with
   `COMPANION_HOST=127.0.0.1`.

3. **Start `takode node` on the host** from its Takode checkout:

   ```bash
   bun web/bin/takode-node.ts --coordinator http://127.0.0.1:13456 --token-file ~/.takode-host-token
   ```

   It installs the `takode`, `quest`, `memory` and `stream` CLI wrappers, skills and
   Quest Journey phase briefs from that checkout, then connects. `takode host
   list` on the coordinator shows the host as online.

4. **Start sessions on it.** Pick the host in the **Machine** field of the new
   session dialog, or from a leader run
   `takode spawn --host <name> --cwd <checkout path on the host>`. A leader
   that itself runs on a host spawns its workers there without `--host`. With a host
   selected, the dialog's folder browser and branch picker read the host's
   folders and repos, and recent folders are kept per machine. Worktrees are
   created on the host. Folder browsing needs the host's `takode node` to run a
   build that includes it. A running session's Git status, diffs, the diff
   panel's base-branch and commit choices, and pulls all read its checkout on
   the host. Quest delivery checks (`takode board approve-delivery-target`,
   `record-work-delivery`, `work-to-memory` and port tracking) run on the
   machine holding the worker's port target, and recorded delivery commits are
   read there later; these need the host's `takode node` on a build that
   includes them. The **Terminal** page opens a session's terminal on its
   host; its machine menu, next to the folder, moves the terminal to any
   machine, browsing that machine's folders.

## Shared machines

On a machine that other people also use, such as a node of a shared compute
cluster, every user's processes can connect to its `127.0.0.1` ports. Two
of them lead to the coordinator: the local end of the tunnel and the API proxy
that `takode node` serves for its agent CLIs. Anyone who could use the
coordinator could start sessions and message agents, which runs commands as
you on every machine, so neither may answer an anonymous caller:

- **The host port takes only tokens**, whether or not browser login is on: the
  host link needs its host token, and every other request needs a valid agent
  session token. A tunnel that ends there gives the machine's other users
  nothing without one.
- **The node's API proxy** forwards to the host port, so it refuses anonymous
  callers too. `takode`, `quest` and `memory` run outside a session on the
  host, without a session token, are refused as well.
- **The main port refuses other machines' hosts while browser login is off**,
  because a tunnel to it would let anyone on the host use Takode. The node's
  log then says `Coordinator refused the link (403: ...)` and names the host
  port; point the tunnel there and the node connects again on its own. With
  login on, the main port requires a login or token anyway, so hosts may still
  use it. The coordinator's own node always may.

What remains: root and administrators of the host can read your files,
including the host token and the session tokens in your processes'
environment, and can act as you. Keep the host token file readable only by
you (`umask 077`, as above). On the coordinator's own machine nothing changed:
with browser login off, its main port still serves anyone who can reach it, so
run the coordinator on a machine you do not share, or turn login on.

## Machine names

Every machine has a name that belongs to the machine, kept in its own
`~/.companion/machine.json`, so it stays the same if another machine later
becomes the coordinator. The coordinator names its own machine after its
hostname the first time it starts. A host takes the name it was registered
with, unless it already has a name of its own from another Takode setup, which
it keeps. Rename any machine with **Rename** in **Settings → Hosts**; a host
must be connected to receive its new name.

Each session's instructions and memory catalog say which machine it runs on and
which machine runs the coordinator. Quest notes and debriefs are stamped with
the machine of the session that wrote them, shown next to the author in
Questmaster and in `quest show` and `quest feedback`, because paths and
commands in a note refer to that machine. Notes written before stamps existed
were stamped once by the coordinator on its first start with this feature,
after it saved the whole quest store under
`~/.companion/questmaster-backups/migrations/`; `questmaster-live/machine-stamps.json`
records that run and the backup that undoes it.

Memory notes record the same thing in a `machines:` frontmatter list: the
machines that wrote the note, in the order they first did. The server adds the
writing session's machine on `memory write` and on every `memory commit` except
repairs. The memory catalog names the machine most notes come from once and
tags the others after their path, like `note.md [devbox]`; the Memory page shows
the list on each note. Notes written before this existed were stamped once with
the coordinator's machine on its first start with this feature, as one memory
commit per repo (`git revert` undoes it); `.git/takode-machine-stamps.json` in
the memory repo records that run. A repo that was locked or had uncommitted
changes is tried again at the next start.

## Choosing the agent CLIs on a host

Every machine has its own **Claude Code** and **Codex** settings in
**Settings → Hosts**: the coordinator's own machine, plus one entry per
registered host. Each is a path or command on that machine; an
empty field means the `claude` or `codex` on that machine's `PATH`. The
coordinator stores the settings and sends a host its own whenever it connects
or they change, so there is nothing to copy between machines. New sessions use
a changed setting at once; running ones pick it up when they relaunch.

`takode node` can also be started with `--claude` and `--codex`:

```bash
bun web/bin/takode-node.ts ... --claude /path/to/claude --codex /path/to/codex
```

A flag wins over the host's setting for as long as that node runs, and
**Settings → Hosts** shows which program the flag makes it run. Prefer the
setting; keep the flags for a node that must differ from its stored setting.

For example, to run a host's Claude sessions through GitHub Copilot, run
`scripts/setup-claude-copilot.sh` on the host (see
[Using Takode with GitHub Copilot](github-copilot.md)) and set that host's
**Claude Code** to the launcher it prints.

## Keeping worktrees across machine moves

Session worktrees go in `~/.companion/worktrees` on the machine that runs the
session. When a host can be moved to another machine, as a cluster job that
is requeued onto another node is, set that host's **Worktree folder** in
**Settings → Hosts** to an absolute folder on storage that outlives the
machine, such as a shared file system. Worktrees created from then on go
there, so after a move the session resumes in the same folder with its
uncommitted files. The repository the worktrees belong to must be on such
storage too, since a worktree only works with its repository. The
conversation itself is kept by Claude Code or Codex under the machine's home
folder; when that is lost, the session continues in a fresh conversation as
described in [Keeping it running](#keeping-it-running).

## Keeping it running

Neither the tunnel nor `takode node` restarts by itself after a reboot. Run each
in a restart loop inside `tmux` (or a service manager), for example:

```bash
# On the coordinator's machine
tmux new -d -s takode-tunnel \
  'while true; do ssh -R 13456:127.0.0.1:4456 <host> -- "while true; do sleep 3600; done"; sleep 5; done'

# On the host
tmux new -d -s takode-node \
  'cd ~/takode && while true; do bun web/bin/takode-node.ts --coordinator http://127.0.0.1:13456 --token-file ~/.takode-host-token --auto-update; sleep 10; done'
```

What survives what:

- **Network drops, host sleep and coordinator restarts:** sessions keep running.
  The host buffers their output and replays it when the link returns, and agent
  CLIs on the host wait for the coordinator instead of failing.
- **Stopping the coordinator** (Ctrl-C, `SIGTERM`; anything but a restart):
  stops the sessions on every connected host, since nobody would see their
  output until the next start. They relaunch and resume their conversation the
  next time they are used; `takode node` itself keeps running. A host that is
  offline at that moment cannot be told, so its sessions keep running and the
  next start takes them over, as after a restart.
- **Restarting `takode node`:** ends the sessions it was running. They relaunch
  and resume their conversation the next time they are used.
- **Replacing the host machine** (a new machine under the same host, or a home
  or worktree folder that was wiped): each session recreates its missing
  worktree when it next launches, on its own branch when the repository still
  has it, otherwise on a fresh branch from its base branch, or from the
  repository's default branch when that base exists only in another machine's
  copy. Uncommitted changes in the old folder are gone; to keep them, give the
  host a [worktree folder](#keeping-worktrees-across-machine-moves) on storage
  that outlives the machine. A Claude or Codex session whose saved conversation
  is gone continues in a fresh one. Whenever a session comes back in a
  recreated worktree or a fresh conversation, its agent's first message is
  one notice saying what was kept and what was lost; for a lost conversation it
  also explains how to recover context from the session history, as after a
  leader recycle. Reinstall anything a host's
  **Claude Code** or **Codex** setting points to on the new machine (such as
  the Copilot launcher); until then a launch fails with the missing path.

## Keeping this machine's sessions across restarts

The coordinator's own sessions survive its restarts the same way: the server
starts a `takode node` on its own machine and runs the processes of sessions
without a host under it. After a restart, the new server takes them over when
that node reconnects: a turn in progress keeps running, its output arrives, and
a pending permission prompt is asked again. A session whose instructions from
Takode have changed since its process started is not taken over: its process is
ended, and the session starts afresh with the new instructions on its next
message. When the restart brings new code,
the node is then updated right away (see [Updating Takode](#updating-takode)),
which interrupts such turns and continues them on the new build. **Settings → Hosts** shows the
node's status on the coordinator's own machine, the first entry. Sessions that start
while the node is still connecting, such as just after the server starts, wait
for it; if it does not connect within 30 seconds, they start without it.

The server supervises this node itself: it starts it with the server (also
after a reboot), lets a running one reconnect after a restart, and replaces one
that has exited or stays disconnected for 30 seconds. The node runs from the
server's own checkout, so an update restarts it on that checkout's code (see
[Updating Takode](#updating-takode) for when). Its log is
`~/.companion/logs/local-node-<serverId>.log`.

Only a restart (the Restart Server button) leaves the node and its sessions
running for the next server to take over. Stopping the server stops its
sessions and then the node; they relaunch when next used. Ending the node's
process (the `takode-node.ts` process with `--shared-checkout`) ends its
sessions too; they relaunch when next used, and the server starts a new node.

## Updating Takode

Restart Server loads the latest code published on the branch the
coordinator's own checkout tracks. Before its usual load check and frontend
build, a production server's restart fetches that branch, fast-forwards the
checkout when it is behind, and runs `bun install --frozen-lockfile` in `web/`,
so changes pushed or landed from other checkouts, dependency changes included,
take effect without updating it by hand.

The restart stops instead, and the running server keeps running, when the
checkout cannot simply follow its branch: uncommitted changes to tracked files,
local commits, no branch or no tracked remote branch, a failed fetch, a failed
fast-forward or a failed install. The error says why and what to do; untracked
files do not count. **Settings → Restart** shows which commit the server runs,
where its checkout stands, and ahead of time whether a restart would stop.

To restart onto the checkout as it is (for example while its remote is
unreachable, or to run local changes), turn off **Update the checkout before
restarting** there. Development servers (`make dev`) always restart onto their
working tree as it is, and package installs, which have no Git checkout, are
not updated.

The host's checkout should run the same commit as the coordinator. `takode
host list` and **Settings → Hosts** show each host's commit and flag a
host on another build.

Start `takode node` with `--auto-update` to let the coordinator keep it in
step. When the host runs another commit, the node first gets ready without
changing what it runs: it makes sure its checkout has the coordinator's commit,
fetching it from the checkout's remote if needed. A commit the coordinator runs
without having pushed it (a private fix, an experiment, a fork) comes from the
coordinator itself: it sends the Git objects the host's checkout lacks over the
host link (up to 32 MB), and the node checks and imports them. Only once the
host is ready does the coordinator stop its sessions; the node then checks out
the commit, runs a frozen install and restarts, and the sessions relaunch on
their next message. A host that cannot get ready keeps its sessions running and
shows why. It refuses to update a checkout with uncommitted changes, so give
the node a checkout of its own rather than one you work in, and a checkout that
shares no history with the coordinator's. When the update happens:

- **After Restart Server**, every such host (and the coordinator's own node)
  updates right away, so all sessions run the new build as on a single
  machine: once the host has reconnected and its sessions are taken over, turns
  in progress are interrupted, the sessions stop, and each interrupted session
  is told to continue once the node is back (or if the update fails).
- **Otherwise** (the coordinator started some other way, a host connected
  later on another build, or a host restarted on its old build after an
  update) it waits until none of the host's sessions is in a turn or running a
  full `takode land test --full`, and none started in the last minute. An
  update after Restart Server does not wait for those test runs (they take
  10+ minutes each); it ends them and tells their sessions to run them again.
- **Never during a landing run** on that host: the update waits for it to
  finish. While the node restarts, anything the coordinator would start there
  waits for the updated node, and new sessions on that host are refused with
  "restarting for a Takode update" until it is back. If the node reconnects
  without having restarted, the coordinator asks it again, so an update that
  failed while the link was down is reported; one that has not brought the node
  back after 15 minutes counts as failed, and what waited runs on the node's
  current build. A failed update is not tried again until the node restarts.

`takode host list` and **Settings → Hosts** say what a pending update is
waiting for.

Without `--auto-update`, update the host's checkout and restart `takode node`
yourself whenever the coordinator is updated.

## Your instructions and skills

Every machine gets the same user-level instructions and skills from the server's store: a newly connected host receives them right away. Files and skills it already has that differ from the store wait for the user's approval (an agent following the `takode-user-content` skill goes through them with the user). See [Your instructions and skills on every machine](user-instructions-and-skills.md); when you set up a host for a user, explain this and offer the switch as described in [Moving the coordinator](moving-the-coordinator.md#your-instructions-and-skills).

## Moving the coordinator to another machine

The coordinator role can move to a machine that already runs its sessions as a
host, for example from a laptop to an always-on workstation, while every
session stays on the machine where it runs. `scripts/coordinator-handoff.ts`
moves the data with checksums, relabels sessions to their machines and fences
the old machine; see [Moving the coordinator](moving-the-coordinator.md) for
prerequisites, connectivity, rehearsal, cutover, verification, rollback and
pitfalls.

## Latency

Every command an agent on the host runs (`takode`, `quest`, `memory`, `stream`) is a
round trip to the coordinator, through the tunnel if you use one.
`takode latency` on the host shows that time as transport. A remote terminal
echoes each keystroke after one round trip.

# Moving the coordinator to another machine

The **coordinator** is the Takode server that holds everything shared: sessions,
quests, memory, boards and settings. This guide moves that role to another
machine, for example from a laptop that sleeps to an always-on workstation,
while every session stays on the machine where it runs. It assumes you already
know [remote hosts](remote-hosts.md).

The data move is done by `scripts/coordinator-handoff.ts`, because it is easy
to get wrong by hand. Everything around it (tunnels, supervisors, startup) is
ordinary configuration of your machines, so this guide describes what to set
up rather than shipping scripts for it. The examples use the machine names
`laptop` (old coordinator) and `workstation` (new coordinator); use your own.

## What happens to what

- **Sessions stay where they run.** The old coordinator's own sessions become
  sessions on a host named after its machine (`laptop`). Sessions that already
  ran on the new machine as a host become the new coordinator's own. Sessions on
  any other host stay there. Every session process ends once during the move;
  each session resumes its conversation the next time it is used.
- **Moves with the coordinator:**
  - settings and their secrets (the server keeps its identity);
  - quests with their images and evidence;
  - memory repos, whole, with their Git history and remotes;
  - unarchived sessions with their timers, notifications, boards and attachments;
  - registered hosts, landing gates and the landing queue, to-dos and the other
    server state;
  - your instructions and skills store (`~/.companion/user-instructions` and
    `~/.companion/user-skills`). A store folder that is a link moves as the same
    link, so clone the checkout it points to on the new machine first, at the
    same path (see the next section).
- **Stays on the old machine:**
  - archived sessions, whose history remains in its files and is not searchable
    on the new coordinator (only their token usage moves, so the workspace token
    totals keep counting them);
  - logs and resource leases;
  - auxiliary worktree registrations;
  - worktree checkouts and agent artifacts;
  - per-machine data such as Codex homes and the machine's name.
- **Numbering and epochs continue.** New sessions are numbered above every old
  session, archived ones included, so `#N` references stay unique. The new
  coordinator starts with a higher coordinator epoch, so hosts accept it.
- **The old machine is fenced.** After the export, a server with this identity
  refuses to start on the old machine and prints where it moved (exit code 44,
  which `make serve` does not restart). Two coordinators with one identity would
  split quests, memory and sessions. `reclaim` lifts the fence for a rollback.

## Your instructions and skills

Moving the coordinator usually means the user now works across several
machines, which is exactly when their personal instructions and skills tend to
drift apart. Before you propose or run a move (or add a host), check how they
are handled today and explain it to the user:

1. **Look.** Load the `takode-user-content` skill. `takode user-content status`
   shows whether a store exists and, while it is empty, what each connected
   machine would bring in: rules size, whether Claude and Codex share one file,
   and skill names. Also note copies kept by hand (`CLAUDE.md` or skill links
   into personal checkouts, temporary copies), since those are what drifts.
2. **Explain.** Without a store, each machine keeps its own
   `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and skills, and sessions on other
   machines do not see them. With a store, Takode keeps one copy on the
   coordinator and owns those files on every machine. See
   [Your instructions and skills on every machine](user-instructions-and-skills.md)
   for how it works, what is backed up, and how identical items need no
   approval while different ones wait for the user's.
3. **Recommend switching** when the user runs sessions on more than one
   machine: most such users want one copy. Suggest keeping the content in a
   private Git repository, with both store folders linking into one checkout of
   it on the coordinator, so edits are versioned and survive a move.
4. **Migrate with the user's approval**, following the skill: pick the
   machine that holds the user's real copy (usually the one they have worked on
   longest), fill the store from it or from the repository, and take over each
   other machine once its waiting items are shown to hold nothing unique.
   Identical items switch over by themselves. Afterwards, remove the hand-made
   copies and links (`takode user-content remove-skills`), so no session loads
   a skill twice.
5. **When moving** with a store that links into a checkout, clone that
   repository on the new machine at the same path before the import, or the
   moved links point nowhere. A store of plain folders moves as is.

## Prerequisites

1. **The new machine already runs as a host** of the current coordinator, with
   a Takode checkout, signed-in agent CLIs, and its Claude Code and Codex
   programs stored in **Settings → Hosts**. A program set only through a
   `takode node --claude/--codex` flag is not carried over; store it in Settings
   first. Credentials are never copied between machines.
2. **The old server runs a build that includes the handoff tooling**, and has
   been started once on it. That start stamps older quest and memory notes with
   the old machine's name; the export refuses until it has. Otherwise the new
   machine would stamp them with its own name.
3. **A separate checkout for the new coordinator** on the new machine, not one
   that a node's `--auto-update` moves or that workers port into, at the same
   commit as the old machine's checkout, with a frozen install. Once the move
   is done, put it on the branch the coordinator follows, tracking its remote
   branch, so Restart Server loads what lands there (see "Updating Takode" in
   [Remote hosts](remote-hosts.md#updating-takode)).
4. **Connectivity, set up and tested before the move** (next section).
5. **Someone to run the cutover from outside Takode.** Every Takode session on
   the old machine stops with its server, so the agent or person running the
   cutover must not be one of them. A standalone Claude Code or Codex session in
   a terminal works well with a written runbook.

## Connectivity

The new coordinator serves two ports: the **main port** (3456) for browsers and
CLIs, and the token-only **host port** (main + 1000, so 4456) for hosts. While
browser login is off, a coordinator refuses hosts on its main port, so every
host must reach the host port.

- **Bind to loopback** when the coordinator should only be reached through
  tunnels: start it with `COMPANION_HOST=127.0.0.1`. With browser login off,
  anyone who can reach the main port can use Takode.
- **The old machine becomes a host.** It needs two paths to the new
  coordinator: one to the host port for its `takode node`, and one to the main
  port for its browser. When only the old machine can open connections (for
  example a laptop and a cloud workspace), use forwards opened from it, such as
  `ssh -L 3456:127.0.0.1:3456 -L 4456:127.0.0.1:4456 workstation`, or the
  workspace tool's port forwarding. Forwarding the old machine's own ports 3456
  and 4456 keeps its browser address and CLI defaults unchanged, and works
  because its server no longer runs.
- **Other hosts** need their tunnels moved to the new coordinator's host port.
- **Remote browser access** (for example a phone through a reverse tunnel to a
  relay): plan a switch from the old machine's tunnel to one from the new
  machine. Test it on a second relay port first. At cutover, stop the old
  tunnel before starting the new one, so the relay frees its port. See
  [Monitor-free relay tunnel supervision](relay-tunnel-supervision.md) for a
  supervised tunnel.
- **Keeping it running.** Run the coordinator, its tunnels and the old machine's
  node in restart loops (tmux or a service manager). If the new machine has no
  start hook (some cloud workspaces do not), have a watchdog on another machine
  start it when unreachable, and note that it stays down after a restart until
  something does.

## Rehearse

Rehearse on the new machine with a copy, without stopping the live coordinator:

```bash
# On the old machine (repository root), live server still running
bun scripts/coordinator-handoff.ts export --rehearsal --to workstation \
  --address https://takode.example.com --package-dir /tmp/takode-rehearsal

# Copy the folder over, e.g. rsync -a /tmp/takode-rehearsal/ workstation:takode-handoff/staging/

# On the new machine, under a separate HOME and port
mkdir -p ~/rehearsal-home/.companion && cp ~/.companion/machine.json ~/rehearsal-home/.companion/
HOME=~/rehearsal-home bun scripts/coordinator-handoff.ts import --package-dir ~/takode-handoff/staging --port 3471
cd web && HOME=~/rehearsal-home PORT=3471 COMPANION_HOST=127.0.0.1 bun --no-install serve.ts
```

A rehearsal copy cannot start agents (its machines' Claude and Codex programs
point to a program that does not exist), sends no phone alerts and carries no
secrets, so copied timers and herd events cannot resume real sessions next to
the live ones. The import refuses on a machine other than the one the package
names, which is why the rehearsal HOME gets the machine's `machine.json`.

Check sessions, quests, boards and memory in a browser through a forward. To
try the old machine's node path, register a host under another name on the
rehearsal coordinator (`POST /api/hosts {"name":"laptop-rehearsal"}`, or
**Settings → Hosts**). Run a `takode node` against it and start a throwaway
session there; the moved sessions themselves stay on the never-connected
`laptop` host. Stop the rehearsal server and its node afterwards.

**Keep the staging copy.** Copying 1-2 GB through a relayed tunnel can take
many minutes. At cutover, rsync the fresh package onto the staged copy; only
changed bytes travel, which took about a minute in a real move.

## Cutover

Write a runbook with exact commands, the expected output of each check, a
go/no-go point before the downtime, and the rollback. Have the outside agent
follow it and stop on anything unexpected. Its outline:

**Preparation (no downtime):**

1. Pin the commit. Both checkouts (the new coordinator's and the old machine's
   future node clone) are at it, and it is published.
2. Check the live system: the new machine's host is online, no landing run is
   in progress, and the target ports are free on the new machine.
3. Retire any test coordinator and its watchdog on the new machine, so nothing
   restarts it mid-cutover.
4. Pre-sync a fresh rehearsal package to the staging folder.

**Downtime:**

1. Stop the old server with a **normal stop** (Ctrl-C or `SIGTERM`, not Restart
   Server). It stops its sessions and its own node. Check that nothing listens
   on 3456 or 4456 and that the node's process is gone.
2. Export:

   ```bash
   bun scripts/coordinator-handoff.ts export --to workstation \
     --address 'https://takode.example.com' --package-dir ~/takode-handoff/pkg
   ```

   It prints how many sessions move to each machine, where numbering
   continues, each memory repo's head and the epoch, then fences this machine
   and writes the token file for its node. It refuses while the server or its
   node runs, during a landing run, or while older notes lack machine stamps.
   If it fails before printing that the machine is fenced, nothing moved.
3. rsync the package onto the staging copy.
4. Stop the old tunnels and the new machine's own host node: its sessions now
   belong to the coordinator, which runs them under its own node.
5. Import on the new machine, first with `--check`, which verifies every
   checksum and lists the paths it would replace, then with
   `--replace-existing`. Data from an earlier Takode run on that machine is
   moved into `~/.companion/coordinator-handoff-backups/<time>/`, not merged.
6. Start the coordinator with its supervisor and its remote-access tunnel.
   Wait for `/api/ready`, and check the log for `Restored N session(s)` and
   the expected next session number.
7. Start the old machine's forwards, then its node from a clean shell (see
   Pitfalls):

   ```bash
   bun web/bin/takode-node.ts --coordinator http://127.0.0.1:4456 \
     --token-file ~/.companion/hosts/<serverId>-node.token --auto-update
   ```

   Run it from a checkout of its own if it uses `--auto-update`.

## Verify

- `GET /api/hosts`: the coordinator's own machine and its node online, the old
  machine online as a host on the same build, each with the Claude and Codex
  programs you expect. An anonymous request to the host port answers `401`.
- Session count per machine matches the export's summary; quest total matches
  the count before the move; `memory catalog show` answers and each memory
  repo's head matches the export.
- In the browser: sessions with host chips, a leader's board and
  notifications, Questmaster.
- Send a message to a new throwaway session on each machine, and to one existing
  session on the old machine; each should answer, the existing one resuming
  its conversation.
- Remote browser access on its normal address, and the fence file on the old
  machine (`~/.companion/coordinator/<serverId>.moved.json`).

## Rollback

Changes made on the new coordinator after the move are lost; the old machine's
data is exactly as it was at the export.

1. Stop the new coordinator (normal stop), its remote-access tunnel, and its
   own node if it is still running.
2. Stop the old machine's node and forwards.
3. On the old machine:
   `bun scripts/coordinator-handoff.ts reclaim --after-epoch <n>`, where `<n>`
   is the `epoch` in `~/.companion/coordinator/<serverId>.json` on the new
   machine (hosts that followed the coordinator refuse a lower one). Start the
   old server again.
4. Restore the old tunnels. The restarted server runs a build with the host
   port, so point host tunnels at its port 4456.
5. Restart the new machine's host node.

## Pitfalls from a real move

- **Start long-lived services from a clean shell.** A service started from an
  agent's shell inherits Claude Code's own environment. One cutover killed the
  old machine's last tmux session, so the next `tmux new`, run by the cutover
  agent, started a new tmux server with the agent's environment, and the node
  passed Claude Code's host-auth variables (`CLAUDECODE`,
  `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` and others) to every Claude it started.
  They all answered "Not logged in". Start nodes and tunnels from a login
  shell, or clear those variables first (`tmux set-environment -g -u <name>`
  removes one from a running tmux server), and check a node's environment
  with `ps eww <pid>`.
- **Agent sandboxes** may block `git fetch`, tmux sockets, loopback ports or
  writes outside the repository; run the cutover agent without them.
- **Self-matching checks:** `pgrep -f <pattern>` inside `bash -c` matches its
  own command line. Check by process id or with `ps`.
- **A session opened before its host connects** may post a "host is offline"
  error into its chat. Connect the old machine's node before opening sessions.
- **Machine programs:** the export notes when the new machine has no stored
  Claude Code or Codex program, for example when its node only had a flag. Fix
  it in **Settings → Hosts** before agents launch there.
- **Terminals without a server:** a `quest` command in a terminal on the old
  machine that reaches no server may fall back to that machine's stale local
  files. Set `COMPANION_PORT` to the forwarded main port there.
- **Landing runs** start on the machine of the oldest waiting change (through
  that machine's node when it is a host), not necessarily the coordinator's,
  and install dependencies through that machine's package registry
  configuration.

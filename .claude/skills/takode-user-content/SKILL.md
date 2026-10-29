---
name: takode-user-content
description: "Use when asked to set up, migrate, check or repair the user's Takode-managed instructions and skills (personal CLAUDE.md, AGENTS.md and skills kept once and delivered to every machine), when Settings hands you that job, or before moving the coordinator or adding a host."
---

# Takode-managed instructions and skills

The user's personal rules and skills used to live in each machine's home folder, so every machine had its own copy and the copies drifted. Takode can keep them once, in a store on the coordinator (the machine that runs the Takode server), and give every machine the same copy. This skill is how you set that up, migrate existing files into it, and keep it healthy. The Settings section only hands this job to a session; the work and the conversation with the user are yours.

## How it works (explain this to the user in plain words)

- **The store** is two folders on the coordinator:
  - `~/.companion/user-instructions/all.md` for every session, plus optional `claude.md` and `codex.md` added after it for one backend;
  - `~/.companion/user-skills/{all,claude,codex}/<skill>/`.
  
  Either folder may be a link into a Git checkout. Takode follows the links and notices edits and pulls made through them.
- **What Takode owns on every machine:**
  - `~/.claude/CLAUDE.md` (all + claude);
  - `~/.codex/AGENTS.md` (all + codex);
  - one link per store skill in `~/.claude/skills` and `~/.agents/skills`.
  
  Plain Claude Code and Codex sessions on that machine read the same copy as Takode sessions.
- **When it updates:** before each session launch, when a host connects, and within about 30 seconds of a store change. A running session picks up changes at its next relaunch.
- **What it touches without asking:**
  - It creates what is missing.
  - It replaces anything identical to the store's copy (nothing is lost), with a backup.
  - It leaves anything different alone, as **waiting** for the user's approval.
  - It never touches skills that are not in the store, or Takode's own skills. Takode's skills win a name clash.
- **Backups:** every replaced or moved file goes to `~/.companion/backups/user-content/<time>/` on its machine.
- **Edits:** the user edits the store, not a machine's copy. A hand edit on a machine makes that file the user's own again, and it stops updating there.

The user-facing doc is `docs/user-instructions-and-skills.md` in the Takode repository.

## Commands

| Command | What it does |
|---|---|
| `takode user-content status` | The store's state; per machine, what waits and what each waiting item holds that the store lacks ("only here"), plus the last backup folder. While the store is empty, what an import from each machine would bring in. Add `--json` for everything. |
| `takode user-content import --machine <name>` | Fills an empty store from that machine, then takes over that machine's files. |
| `takode user-content take-over --machine <name>` | Replaces that machine's waiting files and skills with the store's. |
| `takode user-content remove-skills --machine <name> <skill>... [--dangling]` | Moves the user's own skill entries (and, with `--dangling`, links that point nowhere) out of that machine's skill folders into a backup folder. It never touches Takode's skills or store links. |

`<name>` is a machine name from `takode host list`, or `this` for the coordinator's machine. Import, take-over and remove-skills change the user's files: run each only after the user approved it for that machine.

## Setting it up (no store yet)

1. **Look.**
   - Run `takode user-content status`. If previews are still being read, run it again shortly.
   - Note which machine holds the user's real, current copy (usually the one they have used longest), and where the copies differ.
   - Also look for hand-made copies: rules files or skill links pointing into personal repositories, temporary copies, and stale or broken links.
2. **Explain** the system in a few sentences, what you found on each machine, and your plan. Then ask the user to choose:
   - **Import from one machine.** This is the simplest.
   - **Keep the content in a private Git repository.** Recommended for anyone who wants history or works across machines. Creating and pushing a repository is an external action, so ask first, and use the account the user names.
   - **Which skills are universal.** Drop obsolete ones. Leave out provider-installed skills unless asked: Codex's hidden `.system` folder and curated skills such as `pdf`, which Takode links into `~/.agents/skills` from `~/.codex/skills`.
   - Copies of skills from another repository can carry stale references to their old home; point them out.
3. **Fill the store.**
   - **Import:** `takode user-content import --machine <name>`.
   - **Repository:** on the coordinator, clone it once (for example `~/Code/<repo>`) with the layout below, then link the store folders into it with links relative to `~/.companion`, so they still resolve if the coordinator later moves to a machine with another home path:
     ```
     <repo>/user-instructions/all.md
     <repo>/user-skills/all/<skill>/
     ln -s ../Code/<repo>/user-instructions ~/.companion/user-instructions
     ln -s ../Code/<repo>/user-skills ~/.companion/user-skills
     ```
     Create the links last: as soon as a store folder exists, Takode starts delivering.
4. **Wait about 30 seconds**, then run `takode user-content status` again. Every connected machine now has the store's copy, except what waits.
5. **Go through each waiting item.**
   - Read its "only here" lines.
   - Anything genuinely unique belongs in the store, or the user decides to drop it. A difference you caused yourself (for example a sentence you rewrote in the repository copy) is not a loss.
   - Ask the user to approve the take-over per machine, naming what will be replaced and where the backups go, then run `take-over`.
6. **Clean up duplicates**, so agents don't load stale or second copies:
   - skills the user dropped, and hand copies under names not in the store: `remove-skills --machine <name> <skill>...`, with approval;
   - links that point nowhere: `--dangling`;
   - folders of temporary copies on the coordinator: remove them with your own tools.
   
   Takode cannot delete arbitrary files on another machine. For anything other than skill entries there, ask a session running on that machine.
   
   A skill that also sits in a repository's own skill folder (for example `.claude/skills` of a personal repository) appears twice in sessions working in that repository. Tell the user, and let them decide where it should live.
7. **Report** in plain words:
   - what each machine now uses;
   - where to edit;
   - how changes spread;
   - the backup folders;
   - how to undo: copy a backup back (Takode then leaves that file alone), or remove the store folders to stop Takode touching anything.

## Checking or repairing (store already set up)

- Run `takode user-content status`.
- **A delivery error:**
  - "Unknown host operation" means that host runs an older Takode; it updates itself, or the user restarts its node.
  - A time-out means the host is slow or offline.
- **Waiting items:** handle them as in step 5.
- **A skill missing on a machine:** check the store's folder (scope `all`, `claude` or `codex`), and that no Takode skill has the same name.

## Moving the coordinator or adding a host

- **Before you propose either**, check this system with the user. Follow "Your instructions and skills" in `docs/moving-the-coordinator.md`.
- **Moving:** a coordinator move carries the store. A store folder that is a link moves exactly as written, so clone its repository on the new machine before the import: at the same place under the home directory for a relative link, at the same absolute path for an absolute one. When that path cannot exist there (for example `/Users/...` on Linux), make the links relative before the export or re-point them after the import.
- **A new host** receives the store when it connects. Its own differing files wait for approval.

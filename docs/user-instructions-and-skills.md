# Your instructions and skills on every machine

Claude Code and Codex read your personal instructions and skills from the home folder of the machine a session runs on. Without help, each machine has its own copy, and the copies drift. Takode can keep them once, on the machine that runs the Takode server (the coordinator), and give every machine that runs sessions for it the same copy.

## Where they live

Two folders on the coordinator make up the **store**:

```
~/.companion/user-instructions/all.md      every session
~/.companion/user-instructions/claude.md   added after all.md for Claude sessions
~/.companion/user-instructions/codex.md    added after all.md for Codex sessions
~/.companion/user-skills/all/<skill>/      every session
~/.companion/user-skills/claude/<skill>/   Claude sessions only
~/.companion/user-skills/codex/<skill>/    Codex sessions only
```

Any file may be missing, and a skill folder needs a `SKILL.md`. Hidden files are skipped.

Either folder, or any entry in it, may be a link. The recommended setup keeps the content in a private Git repository, with both store folders linking into one checkout of it on the coordinator:

```
~/.companion/user-instructions -> ~/Code/<your-repo>/user-instructions
~/.companion/user-skills       -> ~/Code/<your-repo>/user-skills
```

Takode follows the links, and notices changes made through them, such as an edit or a `git pull` in the checkout.

Make the links relative to `~/.companion` (`ln -s ../Code/<your-repo>/user-skills ~/.companion/user-skills`). A relative link keeps working when the coordinator [moves](moving-the-coordinator.md) to a machine whose home directory has another path, such as from macOS (`/Users/<name>`) to Linux (`/home/<name>`); an absolute one would have to be re-pointed there.

Write rules that hold on every machine. A rule that applies to only one machine can say so ("on the laptop, ..."); every Takode session is told which machine it runs on.

## What Takode does with them

On each machine, Takode owns:

- `~/.claude/CLAUDE.md`: `all.md` followed by `claude.md`;
- `~/.codex/AGENTS.md`: `all.md` followed by `codex.md`;
- in `~/.claude/skills` and `~/.agents/skills`, one link per skill, pointing at that machine's copy in `~/.companion/user-content-installed/`. A backend's own skill replaces a shared skill of the same name.

Plain Claude Code and Codex sessions on that machine therefore read the same content as Takode sessions.

Takode updates a machine before each session launches there, when a host connects, and within about 30 seconds of a change to the store. A session reads the files when it starts, so a running session picks up a change at its next relaunch.

## Your own files are never replaced silently

- **A different file or skill that Takode did not write is left alone.** It waits for your approval, with the reason ("differs from the store", "edited by hand after Takode wrote it" for a file Takode wrote that someone then changed, or "a link to …") and what it holds that the store lacks. The agent doing your setup shows you this and replaces it on that machine only after you agree.
- **Something identical to the store's copy needs no approval**, because replacing it loses nothing. Examples: a skill folder with exactly the store's files, or `AGENTS.md` linking to a `CLAUDE.md` that already holds the store's text. Takode replaces it and keeps a backup.
- **Backups:** before replacing or removing anything, Takode moves or copies it to `~/.companion/backups/user-content/<time>/` on that machine. A link is kept as a link. The newest 50 such folders are kept.
- **Takode's own skills win.** A skill with the same name as one of Takode's own (such as `confirm`) is not linked; Takode's skill is used.
- If `~/.codex/AGENTS.override.md` exists, Codex reads it instead of `AGENTS.md`, and the status shows a note.

## Setting it up, or migrating your existing files

An agent does this with you, following Takode's `takode-user-content` skill. Setup involves judgment, so a person and an agent decide it together rather than a fixed sequence of buttons. The judgment calls include:

- which machine holds your real copy;
- which skills you still want;
- whether a Git repository should hold the content;
- whether anything on another machine is unique.

To start it, use either way:

- **From Settings.** **Settings → Hosts → Your Instructions and Skills** shows whether the store is set up and each machine's state. Pick a session and choose **Ask this session to set it up**; Takode sends that session a prompt. To use a fresh session, create one first.
- **From any session.** Ask an agent to set up or check Takode-managed instructions and skills.

After an upgrade, while the store is empty and some machine has instructions or skills of its own, the app shows a one-time notice. **Set up** opens the Settings section; **Dismiss** hides the notice for every browser.

The agent will:

1. look at every connected machine;
2. explain what it found;
3. fill the store, either by importing from the machine you choose or from a repository;
4. go through what waits for approval;
5. clean up old hand-made copies;
6. tell you where to edit from then on.

Until a store folder exists, Takode touches nothing. You can also fill the store yourself, for example by linking it into a checkout.

## Undo and switching off

- **Restore a backup** by copying it back. Takode then sees a file it did not write and leaves it alone.
- **Switch the feature off** by removing or renaming both store folders. Takode then stops touching anything and leaves the files it last wrote in place.
- **An empty store is different.** If the store exists but is empty, Takode removes the files it wrote, after backing them up.

## For agents

Follow the `takode-user-content` skill. It uses `takode user-content status`, `import`, `take-over` and `remove-skills` (`takode user-content --help`). Each of these acts on any connected machine through the coordinator, on the user's approval.

A coordinator move carries the store along. A store folder that is a link moves as the same link, so the checkout it points to must exist on the new machine.

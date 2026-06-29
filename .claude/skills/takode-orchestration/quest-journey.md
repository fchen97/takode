# Quest Journey Lifecycle

Quest Journey v2 has one active workflow for quest-backed work:

`work -> memory`

On a branch that lands through the landing queue, Work ends when the change is submitted and Takode adds a final Landing phase: `work -> memory -> landing`. The quest, not the worker, waits for the change to land.

`user-checkpoint` is a durable pause state for decisions inside the same Work occurrence. It is not a separate default phase handoff and does not create a new worker. Direct worker errands are not Quest Journey states; they are narrow one-turn, context-rich, read-only follow-ups handled by `leader-dispatch` and promoted to a normal quest if scope expands. Legacy v1 phase IDs such as `explore`, `implement`, `code-review`, `execute`, `outcome-review`, `port`, and `bookkeeping` are historical-read compatibility only. Do not dispatch or propose them for new active work.

The work board (`takode board show`) tracks proposed rows, queued rows, active state, worker assignment, human-input waits, timing, and next action. Use `takode board show --full` for full board inspection and `takode board detail q-N` for one row's Journey, notes, legacy compatibility labels, and timing history.

## Active Phase Catalog

Built-in phase directories are seeded into `~/.companion/quest-journey-phases/<phase-id>/` with `phase.json`, `leader.md`, and `assignee.md`. Use `takode phases` to inspect the active catalog and exact brief paths.

| Phase | Board State | Purpose |
|-------|-------------|---------|
| Retained Alignment | `PLANNING` | Existing occurrences preserve their pending approval and history. New Journeys start at Work. |
| Work | `WORKING` | Assigned worker completes the authorized work end-to-end, syncs tracked changes, maintains one current Work note, and attaches synchronized target code SHAs or explicit zero-code evidence through the guarded transition. |
| User Checkpoint | `USER_CHECKPOINTING` | Visible decision pause when Work needs user authority or judgment outside the approved envelope. The assigned worker resumes the current quest in Work to apply the approved routing; same-quest choices continue implementation. |
| Memory | `MEMORY` | Final durable closure: memory triage/update/deferral, quest metadata/debrief/quiz/check hygiene, cleanup/follow-up routing, and quest completion. |
| Landing | `LANDING` | System-managed, never planned by hand. The quest waits for its submitted landing-queue change; Takode records the landed commits as Work evidence and completes the quest, or keeps it here as bounced with a Work and a Memory occurrence added for the fix. |

Historical v1 phase metadata remains available only so stored Quest Detail timelines and old phase notes render intelligibly.

## Authorization

Before first dispatch, use `/leader-dispatch` to choose direct low-risk quest dispatch, pre-dispatch approval, delayed approval through User Checkpoint, or the narrower direct worker errand path. Direct quest dispatch is allowed only for clear, low-risk, reversible repo-local work with no material ambiguity, external side effect, security/privacy/global/shared-resource risk, product/policy choice, or user-level scheduling tradeoff.

Initial dispatch authorizes Work within the recorded quest envelope. The worker reads sources, checks prerequisites and resolves understanding within Work, pausing only for genuine ambiguity, blockers or missing authority. An optional report does not require acknowledgment. Existing Alignment occurrences are retained with their original approval boundary; do not insert new ones. Project safety, durable-data, permissions, leases, external effects, verification and Git rules still apply.

## Work

Work owns the responsibilities that v1 split across Explore, Implement, Code Review, Execute, Outcome Review, and Port. The worker may self-review, delegate to subagents, run approved long operations, inspect outcomes, iterate, commit, sync, run strong verification, and push when authorized.

The worker keeps one current detailed Work note. Refresh that note for iterative fixes instead of appending a process timeline. The final Work note records outcome, key decisions, evidence, sync/external state, residual risk, checkpoint decisions, and Memory handoff. When tracked changes exist, it also names the selected target and ordered synchronized target SHAs on a dedicated `Synced SHAs:` line; the guarded transition attaches those same SHAs as structured quest metadata.

A recoverable interruption does not create a new or smaller Work occurrence. The canonical Work leader brief at `~/.companion/quest-journey-phases/work/leader.md` owns the recovery-routing rule.

### Design-To-Implementation Continuity

When the user's intended outcome includes both design/research and implementation, keep them in one quest and the same Work occurrence. A User Checkpoint may pause that Work for a design choice, but it does not end the accepted build. The visible checkpoint must state whether each choice authorizes same-quest implementation, design-only closure, or a separate implementation successor. For same-quest implementation, the leader records the user's scope and continuation decision and applies any approved scope expansion. If that decision expands a previously design-only current quest to include implementation, reconcile the quest metadata before resuming Work: revise the title when it still reads as design-only, and update the description and TLDR when they no longer cover the full approved design-and-build scope. Do not defer this correction to final Memory. Update the remaining Journey only when needed, clear the wait, and resume the same worker in Work. Do not ask the worker to infer user intent, silently rewrite it, or enter Memory merely because a design was selected.

If an explicitly design-only quest gains implementation scope before completion, prefer revising and continuing that quest when the result remains one continuous outcome; use normal `quest-design` approval when the expansion materially exceeds the approved envelope. If such a quest was prematurely completed, reopen it by default. Use a separate implementation quest only for genuinely optional or deferred work, a materially different owner or schedule, independent review, materially distinct risk or audit isolation, or an explicit user-approved successor. If a valid implementation successor is already active, do not migrate, duplicate, or rewrite its work.

Before telling the user that a feature is implemented, available, or ready to test, verify the responsible implementation quest and state, accepted Work evidence, synchronized commit or artifact evidence, and any required activation, restart, or deployment state. A design selection, design-memory record, probe, or generic tool result is not delivery evidence. If that evidence is absent, say the feature is not yet delivered before attempting a test. When the accepted outcome still includes implementation or another delivery that requires commit, artifact, or activation evidence, perform the same check before Work enters Memory; design-only or investigation quests may enter Memory once their accepted non-implementation result and validation are complete.

Independent review is no longer an embedded phase. When review materially reduces risk, create a separate quest with its own Work -> Memory flow.

## User Checkpoint

Use User Checkpoint when Work needs user authority or judgment outside the approved envelope. Apply `leader-decision-communication` before publishing; it owns decision-first wording and the necessity filter. The user prompt must remain self-contained: findings, named options, key tradeoffs, recommendation, exact requested answer, and an explanation of any notification shortcut whose meaning or tradeoff is not obvious from its label, all in the `takode notify needs-input` context, which Takode shows right before the question card.

User Checkpoints are required by default. A planned checkpoint is optional only when its approved phase note states a concrete skip condition, for example `Optional: skip if Work confirms there is no user-visible tradeoff.` For a direct optional suffix `[work, user-checkpoint, memory]`, if Work proves that condition, the worker skips it only through guarded `work-to-memory` with `--skip-optional-checkpoint "<reason>"`; the reason is recorded. Generic `board advance --skip-optional-checkpoint` remains blocked when it would land directly in Memory because it cannot replace the Work evidence boundary.

A required checkpoint, or an optional checkpoint that is actually taken, must be followed by a later Work occurrence before Memory. If the approved suffix is only `[work, user-checkpoint, memory]`, revise it to include `[user-checkpoint, work, memory]` before entering the checkpoint. Takode enters it when you post the checkpoint question in the quest's thread (see below), and adds the later Work itself if it is missing. Do not answer the decision yourself. After the answer, record and apply the approved continuation and use generic advance to resume the assigned worker into that later Work occurrence. Repeated plans may also use `board advance --skip-optional-checkpoint` when an optional skip lands in later Work rather than Memory. The later Work occurrence applies the decision, refreshes evidence, and owns the eventual guarded Work -> Memory transition. Same-quest routing continues implementation; design-only routing settles the accepted design scope; successor routing records or creates the separate implementation quest while the current worker settles the accepted scope. For externally consequential actions, fail closed on edit-only replies, questions, ambiguous approval, changed safety/monitor/stop conditions, or any remaining choice: publish a revised exact packet and wait for fresh explicit approval.


### Automatic User Checkpoints

A quest is in User Checkpoint while the user has your open question about it. Takode keeps the board in step, so asking needs no board command:

- **Trigger.** A `takode notify needs-input` question you post in a quest's thread while your own board has that quest in Work. Questions in Main, on rows outside Work, or on another leader's board don't pause anything. A worker's own question goes to you; answering it yourself stays in Work. To pass it on to the user, ask in your own question, since the user never sees herded workers' questions.
- **Entering.** Takode links the question to the row and moves it into User Checkpoint: the planned checkpoint when it comes next, otherwise a `User Checkpoint -> Work` pair it adds right after the current Work. Further questions join the same checkpoint. Add `--no-checkpoint` when the work does not wait on a question; it then shows as an open question while Work continues. To make an open question blocking later, `takode board set q-N --wait-for-input <ids>` (list every blocking question). To stop a posted question blocking, `takode board set q-N --clear-wait-for-input`, or `--wait-for-input` without it; dropping a link never resolves the question, so it stays open for the user.
- **During.** The worker may keep working, typically gathering information or brainstorming for the decision; that time counts as checkpoint time. It cannot hand off to Memory until the checkpoint ends.
- **Leaving.** When every linked question is resolved (answered, resolved, or dismissed), a checkpoint Takode added returns to the Work after it for the same worker; pass the answer on to the worker. Muting or snoozing does not resolve. End any checkpoint early, planned or added, with `takode board set q-N --status WORKING`: it resumes the Work after the checkpoint, and its questions stay open but stop blocking. A planned checkpoint is used up only when its questions are resolved: if you end it by hand, or clear its last links, while they are still open, Takode treats the pause as a checkpoint it added, resumes the Work after it, and puts the planned checkpoint, with its phase note, back after that Work, so a side question cannot consume a planned approval step. A planned checkpoint whose questions are resolved keeps leader-driven resumption with `board advance`, which refuses while a question still blocks. Takode refuses `board advance` on Work it already resumed, except to skip an optional checkpoint with `--skip-optional-checkpoint`.
- **Back-to-back.** A new question within 10 minutes after Takode resumed Work reopens the same checkpoint, so a back-and-forth with the user stays one checkpoint; the short Work in between counts as checkpoint time.
- **Dismissed questions.** If the user dismisses one of your quest questions, or a herded worker's question, without answering, you get a `notification_dismissed` herd event, which says when it ended the checkpoint. Decide whether to ask again or tell the worker how to continue.
- **Time.** Each checkpoint has its own phase time, so Work time excludes waiting on the user.
- **Work note.** After a checkpoint the worker is in a new Work occurrence, and Work -> Memory needs a Work note written in it.

## Work To Memory

The assigned worker may use the worker-owned Work -> Memory transition only when all are true:

- caller is the authenticated assigned worker;
- quest is claimed by that worker;
- board state is `WORKING`;
- a current Work phase note by that worker exists;
- no unresolved User Checkpoint is linked;
- required verification, selected-target sync/push, and durable handoff facts are settled;
- the request supplies exactly one fresh code-evidence mode for this Work occurrence.

For tracked changes, including docs, skills, prompts, templates, and other tracked text, pass the synchronized selected-target SHAs:

```bash
takode board work-to-memory q-N --work-note <feedback-index> --commits "sha1,sha2"
```

For a genuine zero-git-tracked-change quest, use the explicit zero-code mode instead:

```bash
takode board work-to-memory q-N --work-note <feedback-index> --no-code
```

## Landing After Memory

On a branch with a saved landing gate, Work ends when the change is submitted (`takode land submit q-N`), not when it lands. The worker hands the quest to Memory with the landing entry instead of synchronized SHAs:

```bash
takode board work-to-memory q-N --work-note <feedback-index> --landing-entry <entry-id>
```

Takode inserts a Landing phase after Memory and Memory runs at once, while the worker's context is fresh. Nothing counts as delivered until the change has landed, and the landing queue still pushes exactly the tree it gated:
- **Reporting:** the accepted-Work report describes the change as submitted, not delivered or ready to test. A quest in Memory or Landing whose change has not landed still blocks `--wait-for` dependents.
- **Completion:** when final Memory completes before the change lands, the quest moves to `LANDING` with final Memory's completion kept, and the worker is free for other work. When the change lands, Takode records the landed commits (and port receipts) as the Work occurrence's delivery and completes the quest; the leader gets a Landing Queue message with the delivery ID. A change that lands during Memory is recorded right away and Memory completes the quest normally.
- **Bounces:** a bounce while the worker is still in Work is fixed in Work. Otherwise the quest stays in, or moves to, `LANDING` as bounced, Takode adds a Work and a Memory occurrence after it, and the leader decides who fixes it and when; `board advance` starts the fix's Work occurrence. The fix submits again, hands off with its new entry, and runs a short Memory that confirms or corrects the earlier debrief and memory notes. The Landing leader brief owns the details.

Classic ports, worktree targets and zero-code quests keep `work -> memory` with synchronized SHAs or `--no-code`.

When one approved optional checkpoint sits directly before Memory and Work has proved its skip condition, add the recorded reason to the same guarded command:

```bash
takode board work-to-memory q-N --work-note <feedback-index> --commits "sha1,sha2" --skip-optional-checkpoint "Work confirmed the approved skip condition."
```

The flag may accompany either code-evidence mode, but it cannot skip a required or already-taken checkpoint. Those checkpoints require a later Work occurrence before Memory. Do not combine commit flags with `--no-code`. Use merged/cherry-picked target-repository SHAs, not worktree-only pre-port SHAs. Every Work occurrence, including rework, must supply its own fresh transition evidence; older quest commits do not prove the current occurrence. New unique target SHAs append to the existing structured code commit list without duplication. The server persists code evidence before moving the row to `MEMORY`, so commit count and diff controls are available as soon as Memory begins. A `Synced SHAs:` note alone is not sufficient.

After the transition succeeds, the worker returns the compact Work handoff and stops the Work turn rather than starting final Memory immediately. This creates the normal leader-visible boundary. The leader confirms tracked Work commits are already visible as structured quest metadata, promptly reports the main accepted answer, finding, or outcome from the Work note using the canonical answer-quality rule, then sends the Memory phase instruction to the normal same worker without waiting for Memory closure. The accepted-Work report normally carries the substantive answer; it must preserve the delivery-evidence guard and must not claim that the still-open quest is technically complete.

Leaders can still inspect or intervene, but routine Work completion does not require leader approval. A user-facing thread may be Ready once the accepted result has been reported even while the quest remains open in Memory for mandatory durable closure.

## Memory

Final Memory is mandatory for every non-cancelled quest. It is asynchronous post-processing from the user's perspective, not an extra delay before the accepted Work result is reported. Memory normally stays with the same worker after Work. It performs catalog/direct-file memory triage, writes or defers durable memory, attaches any new file-based memory-repository commits separately, reconciles quest title/TLDR/description against delivered scope, settles genuine User review checks, records cleanup/follow-ups, writes final debrief metadata, and completes the quest. Routine completion is commentary/status; another answer is reserved for new user-relevant information that materially completes, corrects, or changes the earlier visible answer set.

Memory must not first-attach accepted Work code SHAs. For tracked Work, those synchronized selected-target SHAs must already be structured quest metadata from the guarded transition. If they are absent, wrong, or only present in prose, return the assigned worker to Work instead of repairing the gap with completion-time `--commit` / `--commits`. For zero-tracked-change Work, rely on the guarded transition's explicit request evidence plus fresh git-state validation; no persisted legacy no-code marker is required. For a landing-queue hand-off, the code evidence is the landed commits Takode records when the change lands; Memory neither waits for nor attaches them. Memory-repository commits use `--memory-commit` / `--memory-commits` and never substitute for code evidence.

A quest in `MEMORY` remains technically open but is downstream-unblocking because its substantive result is accepted and synced when applicable; a quest whose landing-queue change has not landed yet stays blocking until it lands. A dependent may proceed unless it explicitly requires an output produced by Memory; that exceptional dependency remains leader-managed. Ordinary read-only follow-up questions during Memory use accepted Work/Memory evidence or the context-rich responsible worker and do not reopen the quest. A changed accepted result or a request for new investigation, implementation, validation, or another substantive deliverable follows the normal rework lifecycle.

Exactly one final memory statement is required:

- `memory updated: <commit>`
- `memory update deferred: <reason or curator>`
- `memory update not needed: <reason>`

Memory must not edit project-tracked implementation files. Missing tracked work returns to Work.

## Board Commands

Common v2 flow:

```bash
takode board set q-12 --worker 5 --phases work,memory --preset v2-work
takode board advance q-12
takode board work-to-memory q-12 --work-note 3 --commits "abc1234,def5678"
# Or, only when Work produced zero git-tracked changes:
takode board work-to-memory q-12 --work-note 3 --no-code
```

Use `takode board propose --summary ... --phases work,memory` when pre-dispatch approval should be durable on the board. Use `QUEUED --wait-for ...` for pre-active scheduling/dependency waits, and `--wait-for #N` on a row in Work only for a helper session the worker waits on (Helper Sessions in `leader-dispatch`). Use `--wait-for-input` only for active/proposed rows intentionally paused on a same-session needs-input notification; Takode links your quest-thread questions to Work rows by itself (see Automatic User Checkpoints).

Legacy v1 phase IDs are rejected for new active rows and revisions. Existing persisted legacy rows, completed historical runs, phase notes, and timings remain readable exactly as stored so they can finish without a rewrite.

## Startup Cutover

Server startup reseeds only v2 live phase directories, removes obsolete live v1 phase directories, and installs/symlinks current skills. It does not rewrite persisted board rows merely to adopt v2. Existing legacy rows finish through compatibility readers; new rows use v2 only.

Existing sessions adopt v2 only after server restart plus relaunch/recycle with regenerated injected instructions. Rereading a phase file alone is not enough.

## Phase Documentation

Every active phase needs durable quest documentation. Prefer:

```bash
quest feedback add q-N --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md --kind phase-summary
```

Use phase-scoped inference when available, or explicit `--phase`, `--phase-position`, `--phase-occurrence`, `--phase-occurrence-id`, or `--journey-run` when needed. Keep phase notes useful and compressed: decisions, blockers, evidence, user choices, external state, residual risks, and next-phase handoff facts. Avoid file-by-file diff narration, long command transcripts, routine green-test lists, and repeated commit metadata.

Final chat handoffs should point to the phase feedback index and include the concise outcome or verdict plus only urgent blockers, safety facts, or narrow phase-required exceptions.

User-owned commit or handoff requests change commit ownership, not evidence requirements. Complete Work's required self-review and verification, plus any independently authorized review, before handing tracked work to the user unless the user explicitly changes those requirements.

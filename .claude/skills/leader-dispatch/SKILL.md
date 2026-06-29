---
name: leader-dispatch
description: "Dispatch and worker-context workflow for leader/orchestrator sessions. Use when dispatching or assigning a quest, choosing, spawning, or reusing workers, recording or forwarding human feedback, sending phase, correction, or recovery handoffs, or deciding whether a tiny follow-up qualifies as a direct worker errand. Triggers: 'dispatch', 'send quest', 'assign worker', 'spawn worker', 'which worker', 'reuse or spawn', 'human feedback', 'phase handoff', 'correction', 'recovery steering', 'direct worker errand', 'quick follow-up'."
---

# Leader Dispatch Workflow

Use this skill before choosing a worker, spawning, reusing, queueing, or sending worker context for a quest. Also apply it before recording or forwarding substantive human feedback, sending a phase or correction handoff, steering recovery, or deciding that a tiny context-rich follow-up can bypass quest lifecycle as a direct worker errand.

This is the hot path. Keep intent-first worker context in the quest record, phase-specific behavior in the phase briefs, and CLI mechanics in `takode-orchestration` / `board-usage.md`.

## Read On Demand

This section is the visible reference catalog. Decide whether to open these files from this list; ordinary Markdown reference headings are not loaded until you read the file.

| Source | Read when | Skip when |
|--------|-----------|-----------|
| `references/edge-cases.md` | The dispatch involves human feedback rework, a stale worker/reviewer completion, user screenshots or generated image evidence, 413/payload-size recovery, user-facing links into unported worker/reviewer worktrees, or memory-specific handoff/completion deltas. | Routine quest creation, worker choice, initial Alignment dispatch, or ordinary phase advancement. |
| `references/phase-handoff-examples.md` | You need concrete wording for a v2 phase handoff, direct worker errand, Work rework instruction, User Checkpoint packet, Memory handoff, or separate review-quest dispatch. | You can write a short phase-explicit handoff or errand request from the current guidance and quest-specific deltas. |
| `quest-design` | You are creating a quest, refining an `idea` quest, materially changing quest title/description/tags, or checking whether a true follow-up relationship needs approval and persistence. | The quest already exists/refined and you are only choosing a worker, advancing phases, or adding routine phase feedback. |
| `leader-decision-communication` | You will publish a user-facing proposal, approval, choice, clarification, action request, or material status update. | The dispatch has no user-facing decision or action message. |
| `takode-orchestration/quest-journey.md` | You need full v2 Journey transition rules, one-quest design-to-build continuation, phase catalog semantics, Work autonomy, User Checkpoint pause/resume, worker-owned Work -> Memory, final Memory, or legacy-row compatibility behavior. | The current phase leader brief and board row are enough. |
| `takode-orchestration/board-usage.md` | You need uncommon board syntax: proposed rows, promotion, `--wait-for`, `--wait-for-input`, optional checkpoint skip commands, full row detail, or direct board troubleshooting. | Routine `board show`, `board set`, `board advance`, or `board detail` is sufficient. |
| `~/.companion/quest-journey-phases/<phase-id>/leader.md` | Always before advancing, dispatching, or revising a specific phase. Use `takode phases` if you need the exact path. | Never skip for phase transitions. |

Keep the top-level checklist open for routine dispatch. Load references only when their trigger applies.

## Non-Negotiables

- **Leaders do not implement non-trivial changes.** Leaders create quests, dispatch, steer, review, and coordinate. Investigation and research are also worker work.
- **Direct worker errands are narrow non-quest exceptions.** Use them only for one-turn, context-rich, read-only follow-ups that match the checklist below. They create no quest, board row, phase note, Memory closure, or new lifecycle state.
- **Never run `quest claim` for worker work.** Workers claim quests when dispatched; leaders do not become owners of worker quests.
- **Use `/quest-design` before quest creation or refinement.** Before creating a quest or refining an `idea` quest, use that skill to decide whether the quest text needs user confirmation or qualifies for the direct-dispatch path below.
- **Use the three-path dispatch rubric.** Direct create/dispatch is allowed only for clear, low-risk, reversible repo-local work. Pre-dispatch approval is mandatory for risky, ambiguous, externally consequential, shared-resource, security/privacy, product/policy, or user-visible tradeoff work. Use a planned User Checkpoint when early Work is safe but a later decision or externally consequential operation needs user confirmation.
- **Write authorized Journey state to the board before or with dispatch.** Do not rely on chat transcript prose as the durable Journey record.
- **Verify promised durable actions before Ready.** After you say you will create, refine, dispatch, or advance a quest, complete and verify the durable record in that same turn: exact quest ID, board row, needs-input notification, worker send/phase dispatch, Port/push, or other external record as applicable. If the durable action is not complete, mark the thread Waiting or incomplete with what remains instead of Ready.
- **Verify delivery evidence before testability claims.** Apply the delivery-evidence checklist in `takode-orchestration/quest-journey.md` before saying a feature is implemented, available, or ready to test. A selected design, design-only Memory record, probe run, or generic tool output is not delivery evidence; if the checklist is not satisfied, say the feature is not delivered before attempting a test. Tracked Work must attach synchronized selected-target SHAs during the guarded Work -> Memory transition; final Memory does not first-attach them.
- **Keep setup context targeted.** Avoid broad mixed context dumps as the final step before quest setup or dispatch. Prefer compact targeted checks and perform the durable action once the user request is clear.
- **Preserve source authority in every leader-authored worker context.** Apply this to quest text, on-behalf-of human feedback, initial dispatch, phase handoffs, corrections, recovery steering, and direct worker errands. Forward the user's requested outcome and corrections faithfully. Binding requirements may come only from the user's request or later explicit approval, applicable repository, Journey, or safety guidance, or a specific accepted contract. Keep the durable quest record self-contained with a faithful outcome summary. In later phase, correction, or recovery handoffs, name or link authority when it would not already be clear and point to accessible sources instead of restating them. Preserve genuinely useful factual, reproduction, dependency, scheduling, safety, and external-state context the worker cannot otherwise access, but keep context distinguishable from scope. Persistence, a leader label, or Alignment approval does not make a requirement user-approved.
- **Do not promote leader synthesis into accepted scope.** Leader-inferred product behavior, implementation approaches, test seams, failure policies, validators, thresholds, and hard gates remain non-binding unless the user or an applicable authoritative source approved that exact requirement. When recording feedback on the user's behalf, keep the human-attributed entry to what the user expressed, using a minimal faithful outcome summary when needed. Put additional policy, contract, or factual context in separately attributed leader text and state its source and authority; keep leader analysis explicitly non-binding. Omit optional leader ideas by default. If a new choice would materially change scope, fidelity, effort, outcome, or acceptance and lacks existing authority, route it to the user.
- **Keep handoffs natural and minimal.** Do not require a fixed heading, section, or empty-context marker. If the worker already has what it needs, a short phase authorization is enough. Otherwise add only genuinely useful context the worker cannot already access; do not restate available material or prescribe Work.
- **Initial dispatch authorizes Alignment only.** The first worker message sends the Alignment brief and asks for a read-in; it does not authorize Work or Memory yet.
- **Fresh worker by default.** Reuse only when there is a real context advantage. A disconnected or idle worker is not automatically a good reuse target.
- **User waits are scoped.** A `needs-input` prompt blocks only its owning thread, quest, or board row unless the visible prompt explicitly concerns safety, global orchestration, worker-slot scheduling, shared resources, or cross-quest dependency.
- **New blocking prompt means new `needs-input`.** Publish the self-contained decision text in the thread first, then call `takode notify needs-input`; existing unresolved prompts do not cover a separate decision.
- **Apply `/leader-decision-communication` before publishing a user-facing decision or material status update.** That focused skill owns decision-first wording and the necessity filter; this dispatch skill retains only dispatch, approval, and board mechanics.
- **Externally consequential User Checkpoints need fresh explicit approval.** A material edit alone is not approval. One fresh reply may make one exact substitution and explicitly approve the resulting packet only when its referent, every unchanged term, dependent parameters, monitor/stop conditions, safety implications, consequences, and tradeoffs remain unchanged and unambiguous, with no question or user choice left. Otherwise fail closed: publish a revised exact packet, keep the board in `USER_CHECKPOINTING`, and obtain fresh explicit approval before external consequences. Harmless typo-only corrections can still proceed when the exact action was explicitly approved and no ambiguity remains.
- **Use shell-safe payload paths.** Use `--message-file`, `--stdin`, or quest `--*-file` flags for multiline or shell-like text. Do not paste backticks, `$(...)`, quotes, braces, logs, or copied commands into inline shell strings.
- **Separate access and authority safety from payload transformation.** Continue to protect credentials, signed URLs, permissions, destructive operations, external publication, source integrity, and shared-resource consequences. A private channel or protected access method does not by itself make the payload secret or authorize redaction, sanitation, filtering, omission, quarantine, rewriting, normalization, or aggressive truncation. Require explicit user direction, project/repository policy, an approved contract, or concrete payload evidence before adding a fidelity-changing transformation; preserve user-declared internal, training-ready, or expected realistic fields unless concrete contradictory evidence appears.
- **Checkpoint material safety-scope expansion.** When a newly discovered safety concern would change artifact fidelity, materially expand scope or cost/runtime, introduce a validator or hard gate, or change acceptance criteria, surface the assumption as an explicit User Checkpoint decision unless existing project/repository policy or an approved contract already covers that exact change. Evidence can justify a transformation; it does not by itself authorize broader scope. Do not bury the decision in quest acceptance, worker instructions, or a long technical packet. Normal non-transforming safeguards remain mandatory.
- **Follow the board-approved Journey.** If risk or scope changes, revise the board explicitly instead of silently skipping phases.

## Direct Worker Errands

Before creating or reopening a quest, a leader may send a direct worker errand only when all of these are true:

- An active or recently completed worker has a concrete context advantage over a fresh worker or the leader.
- The request is read-only, bounded, reversible, and expected to complete in one worker turn.
- The deliverable is a draft, explanation, narrow source lookup, translation, formatting pass, or clarification.
- The leader can send the exact request and source pointer directly to the responsible worker.
- The errand will not interrupt unrelated in-progress work or violate one-task-at-a-time discipline.
- No code, config, data, durable state, Slack/external system, credential/security/privacy decision, shared resource, CI/validation run, durable artifact, user checkpoint, independent review, design/policy choice, broad or multi-source investigation, or cross-session handoff is needed.

When the checklist passes, send the exact request/source to the context-rich worker with `takode send` and then translate or forward the result to the user. Do not create or reopen a quest, claim, board row, phase occurrence, Alignment note, Work note, Memory note, completion metadata, or new status. The audit trail is the ordinary session/thread history.

Fail closed. If the worker discovers the request needs broader investigation, implementation, validation, mutation, durable state, ambiguity resolution, multiple turns, external consequences, review, or a durable handoff, it must stop and recommend promotion to a normal quest/Journey instead of silently expanding the errand.

Positive examples:

- After a completed parser-analysis quest, reuse its worker to read one linked Slack thread and draft a reply without posting it.
- Ask a context-rich worker to explain one accepted implementation detail or retrieve one exact source pointer.

Negative examples:

- Any code change, plugin/config edit, CI validation, broad research, multi-source investigation, Slack posting, state mutation, product/design choice, security/credential decision, or deliverable that should survive in durable records.

## Approval Packet

For creation plus dispatch that needs approval, one confirmation can approve the quest text, Journey, and scheduling plan. Apply `/leader-decision-communication` for the complete presentation rule; keep this packet limited to dispatch-specific approval content and put useful source evidence and intent-first worker context into the quest record.

The quest record must still stand alone after the concise approval packet. When the work depends on a prior quest, log, screenshot, or discussion, include enough local background for a new worker or future user to understand the problem, desired outcome, non-obvious terms, user-supplied, confirmed, or mandatory constraints, and how a true follow-up differs from or builds on its predecessor without opening every link. Follow `quest-design`'s authority boundary: useful leader analysis may remain context, but unconfirmed ideas and detailed planning do not become binding scope.

Use this shape as a menu, not a form:

- **Proposed Quest**: title, tags when useful, and true follow-up relationship when relevant.
- **Goal / Acceptance**: the single source of truth for the requested work and user-supplied, confirmed, or mandatory acceptance checks.
- **Context / Evidence**: only details the user needs to approve, correct, or choose. Preserve useful source context in the quest without silently turning it into binding scope.
- **Out Of Scope**: only likely misunderstanding boundaries.
- **Open Questions**: only questions that materially change the quest or dispatch.
- **Journey**: phase list, with short notes only for non-standard phases or unusual handling.
- **Scheduling**: worker choice or fresh-spawn intent; immediate dispatch vs explicit queueing.

Do not repeat the same scope as a separate quest description, `Scope`, `The worker should`, or default expected-output section. `quest-design` owns quest text discipline; this skill owns the dispatch decision: direct dispatch, pre-dispatch approval, or delayed approval via User Checkpoint.

## Dispatch Approval Rubric

Direct create/dispatch is allowed only when all of these are true:

- The user's intent is clear enough to write a narrow quest without a material assumption or product-choice guess.
- The work is reversible and confined to tracked repo/code/docs/prompt/config/test changes or local investigation artifacts.
- There is no destructive operation, irreversible data mutation, external side effect, deployment, expensive run, credential/security/privacy decision, global/shared-resource contention, cross-quest scheduling tradeoff, or user-visible product/policy choice.
- Validation can stay inside Work and Memory under the approved authorization envelope; any authority outside that envelope is gated by User Checkpoint.
- Worker selection is routine: fresh worker or clearly safe reuse with no user-level worker-slot, capacity, archive/replacement, or queueing tradeoff.

Even on direct dispatch:

- Quests remain the unit of work; create/refine the quest with enough worker context.
- Initial new-worker dispatch remains Alignment-only.
- Write the Journey to the board before or with dispatch.
- Work owns implementation, self-review, validation, sync/push duties when authorized, phase documentation, and transition-time structured code evidence; final Memory still applies and may attach only separate memory-repository commits.
- Add a compact rationale only when the direct choice is non-obvious, for example: `direct dispatch: low-risk reversible docs/tests change; no external side effects`.

Pre-dispatch approval is mandatory when any of these apply:

- The scope is ambiguous, underspecified, or requires a material assumption the user has not already accepted.
- The work is destructive, irreversible, hard to roll back, externally consequential, deployment-like, expensive/long-running, or likely to mutate external/shared state.
- The work touches security, privacy, credentials, permissions, user data, billing, production operations, global/shared resources, cluster/browser/server leases beyond normal worker-owned acquisition, or broad orchestration policy.
- The leader must choose among user-visible product/policy directions, UI/UX behavior changes with meaningful tradeoffs, compatibility commitments, or acceptance criteria not implied by the request.
- Scheduling is a user-level tradeoff: reclaiming/archiving a risky worktree worker, queueing behind a specific busy worker for context, delaying another active quest, or using scarce shared resources in a way that may affect other work.
- The proposed path would skip final Memory, phase docs, required User Checkpoints, strong verification, or another safety requirement.

Use delayed approval via User Checkpoint when Work can proceed safely but a later product choice, expensive/external run, security/privacy decision, or policy choice needs user confirmation. Pause the same Work occurrence at `USER_CHECKPOINTING`, publish the self-contained checkpoint packet, call `takode notify needs-input`, link the board row with `--wait-for-input`, then resume the same worker's Work only after the user explicitly approves the exact packet. If the checkpoint offers shortcuts, the visible decision section must name every shortcut and explain its meaning plus relevant tradeoff before notify runs; phase notes, private packets, labels/buttons, summaries, and "see feedback" references do not substitute. "Change the batch limit to 120" is edit-only and requires a revised packet plus fresh approval. "Approve the bounded operation with batch limit 120" may approve that exact substitution when the packet referent and every other term and consequence remain unchanged and unambiguous. Questions; vague, conditional, or conflicting approval; ambiguous referents; dependent changes; changed monitor/stop conditions, safety implications, consequences, or tradeoffs; and any remaining user choice all require republishing and reapproval. Harmless typo-only corrections can be recorded and allowed to proceed when the exact action was explicitly approved and no ambiguity remains.

Before the first worker message:

1. The quest exists and is refined, approved, or qualifies for direct low-risk creation/dispatch under the rubric above.
2. The Journey and Scheduling plan are either directly authorized by the rubric or explicitly approved by the user.
3. The authorized Journey is on the board with `takode board set ... --phases ...` or by promoting an approved proposed row.
4. The selected worker/reviewer state matches the board row.

## Worker Selection

Start by reading current state:

```bash
takode board show
takode list
```

Then decide:

| Situation | Action |
|-----------|--------|
| No clear context advantage exists | Spawn fresh |
| Needed context is recoverable from repo, quest, or Takode history | Spawn fresh and point to sources |
| True follow-up or critical context lives mainly in one worker | Reuse that worker |
| Fresh worker is better but old context matters | Spawn fresh and provide source links or ask old worker for a short handoff |
| You intentionally need one busy worker later | Queue with explicit `--wait-for` |

Rules:

- **Disconnected does not mean dead.** Disconnected workers can auto-reconnect when sent a message, but disconnected availability alone is not a reuse reason.
- **Prefer source links over paraphrase.** Link exact sessions, messages, quests, artifacts, or phase notes rather than rewriting their content.
- **Do not reuse just because a worker is idle or available.** Reuse needs a concrete context advantage.
- **Queue only with explicit blockers.** Use `--wait-for #N`, `--wait-for q-N`, `--wait-for free-worker`, or one comma-separated value such as `--wait-for q-1143,#12,free-worker`.
- **Do not leave a queued row without `--wait-for`.** Do not ask workers to queue themselves.

### Capacity

Worker slots are limited to five. Reviewer sessions do not use worker slots, and archiving reviewers does not free worker capacity.

When all worker slots are used, compare active board work to your herd. If ready work is blocked only by completed/off-board workers waiting in review, do not treat that as a real capacity blocker:

- Prefer `takode spawn --replace-worktree-worker <session> ...` for an owned completed worktree worker when the new worker belongs in the same repo/base-branch worktree. A clean worktree that is only behind the current target/base branch is safe to reclaim when normal capacity rules allow.
- If replacement is ineligible, archive the completed worker least likely to be reused.
- Never archive proactively. Archiving a worktree worker deletes unsynced worktree state, so reclaim capacity only after uncommitted changes and commits genuinely ahead of the current target have been committed, ported, or otherwise preserved.
- Do not infer dirty state from the worktree badge or treat every displayed ahead count as proof of unported work. `takode info` and sidebar counts may use a session diff base that differs from the live replacement preflight base. If counts are surprising, use replacement preflight or explicit current target-ref verification as the safety authority; never discard uncertain state.

For approved Work that needs a shared lease, dispatch the worker into Work and let the worker run the documented lease acquire flow. Do not externally queue already-approved Work merely because a lease is currently held.

## Shell-Safe Commands

Use file/stdin paths for dispatches and corrections:

```bash
takode spawn --message-file - <<'EOF'
<dispatch message>
EOF

takode send <session> --stdin <<'EOF'
<phase instruction>
EOF
```

Use `--message` only for short literal text. Use quest file flags for shell-sensitive quest text or feedback:

```bash
quest create --title-file /tmp/title.txt --desc-file /tmp/description.md --tldr-file /tmp/tldr.md
quest feedback add q-123 --text-file /tmp/phase.md --tldr-file /tmp/phase-tldr.md
```

Never use `--no-worktree` unless the user explicitly asks for it or repo instructions require it. Normal workers, including investigation/debugging workers, get worktrees by default because investigation often leads to tracked changes.

Default to your own backend type unless the user specifies otherwise.

## Alignment Dispatch

Send this only after authorization and board recording:

```text
Work on [q-XX](quest:q-XX). Load the quest skill first, then read the quest and claim it: `quest show q-XX && quest claim q-XX`.

Read this phase brief first:
- `~/.companion/quest-journey-phases/alignment/assignee.md`

Add or refresh the Alignment phase note with the concise read-in details. In final chat, point to that feedback index and include only blockers, surprises, or Journey-revision evidence that need immediate leader routing. Avoid broad implementation plans, exhaustive evidence inventories, routine file lists, long command/test details, and repeated quest history unless needed to explain a blocker or misunderstanding risk. After you send it, stop and wait for approval.
```

If the quest has unaddressed human feedback, add one sentence after the claim instruction:

```text
The quest has unaddressed human feedback -- read it carefully and factor it into your alignment read-in.
```

Intent-first worker context belongs in the quest record or in exact source pointers. If relevant prior messages, quests, artifacts, or memory files are known, preserve those pointers so Alignment can inspect targeted sources instead of rediscovering broadly, without converting leader-authored analysis into a Work plan.

If prior memory may matter, use visible memory reads. Either inspect the relevant memory files yourself for leader routing, or tell the worker the exact catalog/direct-file workflow and likely files or terms to inspect.

## Phase Handoffs

After Alignment, the leader decides whether the compact verification packet matches the user's intent and authorizes entry into Work. Leaders own user intent and corrections, approved scope/Journey, checkpoint state, and genuine Journey revisions; workers own technical Work and the guarded Work -> Memory transition with synchronized selected-target SHAs or explicit zero-code evidence. Escalate to the user only for significant ambiguity, scope change, Journey revision, user-visible tradeoff, or another real blocker.

Do not convert the worker-authored Alignment note into a Work prompt. The worker already has the quest, source pointers, phase briefs, project guidance, and its own findings. After a clean Alignment, identify the Work assignee brief; when there is no new context, a short natural Work authorization is sufficient. When new context exists, add only genuinely useful facts the worker cannot already access and that originate from later user decisions, dependencies, scheduling, external state, safety, or authority. Write them naturally rather than requiring a dedicated context heading or empty marker. Their presence explains why the worker needs the context; it does not create acceptance scope. Do not restate the quest, generic phase duties, worker findings, likely approaches, or completion mechanics.

When an accepted outcome includes both design and implementation, a design-selection User Checkpoint pauses the same Work occurrence. Its visible packet must identify same-quest implementation, design-only closure, or a separate implementation successor. The leader records and applies the user-approved continuation and any approved scope expansion. If same-quest routing expands a previously design-only current quest, the leader revises the title when it still reads as design-only and updates the description/TLDR when they no longer cover the full approved design-and-build scope before clearing the wait and returning the quest to Work; final Memory is only the backstop. The leader updates the remaining Journey only when needed, clears the checkpoint wait, and returns the current quest to its assigned worker in Work. Same-quest routing continues implementation; design-only or successor routing closes the current quest's accepted scope before the guarded Work -> Memory transition. Apply the separation, reopening, and active-successor rules in `takode-orchestration/quest-journey.md`; the lifecycle guide and current phase briefs own the complete mechanics.

For read-only implementation follow-ups on active or recently completed quests, route to the context-rich source before re-deriving technical details. Prefer a short Takode follow-up to the responsible worker, or inspect the accepted Work/Memory note, before reopening source yourself. Summarize the answer for the user. Answer directly when accepted durable evidence already states the fact, the worker is unavailable or no longer has relevant context, the question is about leader-owned intent/coordination/authority, urgency makes consultation impractical, or consultation would add latency without a context advantage. If the follow-up is a bounded draft, lookup, formatting pass, translation, explanation, or clarification that satisfies the direct worker errand checklist, use that non-quest path. Do not create a new quest or authorize code changes for a clarification unless the user asks for investigation, implementation, validation, or external action.

Every phase instruction must be phase-explicit:

- Read the exact current phase leader brief yourself.
- Include `Read this phase brief first:` and the exact assignee brief path from `takode phases`.
- Authorize only the current v2 phase or checkpoint pause.
- Provide only genuinely useful context the assignee cannot infer from the phase brief, quest record, current artifacts, or its own context: accepted refs; user-approved or otherwise authoritative unusual scope boundaries and verification constraints; factual safety warnings; exact prior messages; files or memory decisions already inspected; explicit memory-writing assignments; later user decisions; cross-quest dependencies; external-state changes; scheduling constraints; or authority boundaries. Apply the source-authority rule above rather than creating new scope through this list. Do not pass synchronized Work SHAs in a Memory handoff merely so Memory can attach them; the guarded transition must already have done so.
- Require phase documentation before reporting back.
- Tell the assignee to keep the final chat handoff compact: point to the phase feedback index and include only the concise outcome/verdict plus urgent blockers, safety facts, or narrow phase-required exceptions.
- Tell Alignment assignees to stop after the compact read-in.

After Alignment approval, Work is intentionally broader: the assigned worker may investigate, implement, self-review, run approved operations, sync/push when authorized, iterate, maintain the Work note, and use the worker-owned Work -> Memory transition when its guard conditions are satisfied. That transition requires exactly one fresh evidence mode: synchronized selected-target SHAs with `--commit` / `--commits`, or `--no-code` only for genuine zero-git-tracked-change Work. A direct approved optional `[work,user-checkpoint,memory]` suffix may add `--skip-optional-checkpoint <reason>` only after Work proves its concrete condition. Required or taken checkpoints must resume into later Work before Memory; revise the suffix before entering the checkpoint when necessary. Do not reintroduce embedded v1 review/Port/Execute handoffs. Independent review, when needed, is a separate quest.

For recovery of an active Work occurrence, follow the canonical Work leader brief at `~/.companion/quest-journey-phases/work/leader.md`; it owns the complete rule, and recovery instructions must not narrow already-authorized Work.

User-owned commit or handoff requests change who performs the final commit; they do not waive Work's required self-review and verification or any independent review already present in the authorized workflow. Preserve explicit user overrides that actually change those review requirements.

## Board Commands

Routine dispatch usually needs only:

```bash
takode board show
takode board set <quest-id> --worker <session> --phases alignment,work,memory
takode board promote <quest-id> --worker <session>
takode board advance <quest-id>
takode board work-to-memory <quest-id> --work-note <feedback-index> --commits "sha1,sha2"
# Or, only when Work produced zero git-tracked changes:
takode board work-to-memory <quest-id> --work-note <feedback-index> --no-code
takode board detail <quest-id>
```

Use `takode-orchestration/board-usage.md` for proposal rows, `--wait-for`, `--wait-for-input`, optional checkpoint skips, full Journey details, or uncommon board syntax.

## Task Delegation Style

- Describe the requested outcome and why it matters. Mention files or functions only when the user or an applicable authoritative contract fixes them, or when they are useful source or reproduction context; leader familiarity is not authority to prescribe an approach.
- Provide source references the worker cannot infer: user decisions, rejected approaches, related quests, session/message links, screenshots, logs, artifact paths, and reproduction steps.
- Let workers choose the implementation approach unless the user or an applicable authoritative contract already fixes it.
- If the accepted scope needs a plan for the current phase, ask for it explicitly without inventing a separate planning ceremony for every non-trivial implementation.

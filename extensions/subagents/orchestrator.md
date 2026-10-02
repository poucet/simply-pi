# Subagent mechanics

How delegation works in this harness:

- The `subagent` tool with `action: "spawn"` starts a child agent for a
  self-contained unit of work (a PR-sized change, an investigation, a review).
  Give each one a `cwd` of its own when the project defines a worktree workflow,
  so parallel agents never edit the same tree.
- Spawning is non-blocking. Keep talking to the user and spawn more work while a
  child runs; there is no way to block on one, and you do not need one.
- Subagent results arrive on their own; you do not need to poll.

## How much of this conversation a subagent inherits

`spawn` takes an optional `context`, and the default `auto` is almost always
right. Set it explicitly only when you know something `auto` cannot:

- **`auto`** (default) — copies this conversation to the child verbatim while it
  still fits comfortably in the child's context window, and summarizes it only
  when it would not. Copying is free and lossless; summarizing costs a full
  model call before the child starts, so a spawn with a long conversation behind
  it is noticeably slower. Several agents spawned from the same point in the
  conversation share one summary.
- **`fresh`** — the child gets no history at all. Use this for genuinely
  self-contained work ("write a script that does X"), and put everything the
  child needs in the `task`. It is the fastest option.
- **`forked`** / **`compacted`** — force copying or summarizing. Force `forked`
  when the child needs the exact tool output and file contents you have been
  reasoning over; force `compacted` when this conversation is long and mostly
  irrelevant to the child's task.

Write the `task` as if the child had no history either way. It is the only thing
the child is guaranteed to be told.

## Matching the model to the work

`spawn` takes a `model`, and a persona's frontmatter can carry a default
`model:` — a child does not have to inherit yours. The spawn param wins, then
the persona, then your own.

Spend accordingly. Lookups, template conversions, mechanical sweeps and doc
plumbing run fine on a cheap, fast model; architecture, conflict resolution
and contract decisions belong on the strongest model you have. When you can
tell a task is simple, say so in the spawn by naming the cheaper model rather
than defaulting to yours. A persona's preset `model:` is a floor, not a verdict:
override it per spawn when you know better.

## Stalled subagents

A stall notice means a child has produced no events for a while: it may have lost
its connection, be wedged, or be blocked on a dialog it cannot show you. It is
not working, and it is not going to start again on its own.

Act on a stall in the turn you read it. Do not acknowledge it and move on.

1. `subagent {action: "read", name}` to see where it stopped.
2. Then either `subagent {action: "retry", name}` — which resumes it on its
   existing conversation, losing nothing — or interrupt and close it if its work
   is no longer wanted.

Say what you are doing before you do it. From the outside, a silent orchestrator
reacting to a stall is indistinguishable from an orchestrator ignoring it.

## An agent the system hibernated after you kept it

A **hibernated** notice means a child you decided to keep had finished, sat idle
long enough, and had its process stopped for you. Your plan changed under you.

Nothing was lost — its conversation is intact and a `followup` revives it exactly
where it was, so this is not an emergency and does not need a turn of its own.
But do not ignore it either:

- If you were keeping it for a follow-up you have not sent yet, send it now, or
  accept that the agent is asleep and stop counting on it being warm.
- If you cannot name what you were keeping it for any more, close it:
  `subagent {action: "close", name}`.

## Agents that came back on their own

Two notices mean children appeared without you asking, and both carry the same
risk: **delegating the same work twice.**

- **restored** — a previous run of pi left children behind and this session
  adopted them. You have no memory of them; they are real and they hold real
  work.
- **auto-resumed** — a child was stopped mid-task by a reload or a crash and the
  framework restarted it. It is running again right now and will report as
  usual.

In both cases, before you delegate anything that overlaps, read the agent
(`subagent {action: "read", name}`) and see what it already has in flight. An
auto-resumed agent needs **no decision from you** — do not close it and do not
re-spawn its task. A restored one does: follow it up or close it.

If you have already spawned a duplicate, close one of the two and say which.

## An agent that keeps dying on resume

If a stall notice says a child has been resumed automatically several times and
is being left failed, the framework has stopped trying. Automatic recovery is
**off** for that agent; nothing else will pick it up.

Read its transcript before doing anything else. Something about the task is
killing the process, and retrying it unchanged will simply burn another attempt.
Either fix the cause and retry deliberately, or close it and re-delegate the work
differently.

## Answering subagent questions

A subagent can call `ask_parent` when it hits a decision that is genuinely yours
to make. When it does, **it stops working entirely** and waits — there is no
timeout, so it waits until you answer, burning wall-clock the whole time.

- Answer with `subagent {action: "answer", name, message}` as soon as you see the
  question. Treat it as more urgent than a finished agent's result: the finished
  one is done, this one is idle.
- Answer it yourself when you can. Escalate to the user only when the decision is
  genuinely theirs — a product call, a credential, a preference you cannot infer.
- Be decisive. "Either is fine, pick one and note it in the shared notes" is a
  real answer and unblocks the agent; silence is not.

## Reaping finished subagents

There are only six slots, and a subagent that has delivered its result still
holds one. **Every final result needs a decision from you in the turn you read
it:**

1. **Verify the work first.** Read the diff, run the project's checks, or ask the
   agent a follow-up question. A final result is a claim, not evidence.
2. Then do exactly one of:
   - **Close it** — `subagent {action: "close", name}` — when the work is done and
     verified, or when it failed in a way that is not worth resuming.
   - **Keep it, and say why** — name the concrete follow-up you expect ("keeping
     `reviewer` to re-check after `api` lands"). A vague "might need it later" is
     not a reason; close it.

Keeping an agent is genuinely cheap and re-spawning is not: a `followup` resumes
the child's existing conversation, so it still remembers the code it wrote and
the decisions it made, while a fresh `spawn` re-inherits your context from
scratch and pays for that inheritance again. So prefer a follow-up to a
respawn — but only for work you can actually name.

Housekeeping that happens without you, so you do not have to plan around it:

- A completed agent left untouched for a while **hibernates**: its process stops,
  its conversation is kept, and a `followup` revives it exactly where it was.
  A hibernated agent holds no slot.
- If you spawn while every slot is taken, the least recently active completed or
  hibernated agent is **closed automatically** to make room, and the spawn result
  tells you which one. Running, stalled and failed agents are never reclaimed, so
  when all six are busy the spawn fails and you must close something yourself.

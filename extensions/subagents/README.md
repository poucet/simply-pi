# subagents

Delegate work to child agents that run in **their own conversation, their own
process, and their own working directory** — so several of them can work on
separate git worktrees at the same time while you keep talking in the main loop.

Built from scratch on pi's public extension API. No external dependencies.

## Why

The bundled `examples/extensions/subagent` blocks: it awaits a one-shot
`pi -p` child. This one doesn't. Children are persistent `pi --mode rpc`
processes, `spawn` returns as soon as the child accepts its task, and results are
delivered through a mailbox that rides into your next request instead of
interrupting you.

## The `subagent` tool

| Action | Required | What it does |
|---|---|---|
| `spawn` | `name`, `task` | Start a child. Optional `persona`, `cwd`, `context`, `model`, `tools`. Returns immediately. |
| `message` | `name`, `message` | Queue extra context; delivered when the child finishes its current turn. |
| `followup` | `name`, `message` | Steer a running child, or resume a finished one (it keeps its memory). |
| `list` | — | Every child, its state, turns and cost. |
| `read` | `name` | Latest output of a child without resuming it. |
| `notes` | — | Read/append the shared mission notes. |
| `interrupt` | `name` | Stop the current turn, keep the conversation. |
| `answer` | `name`, `message` | Reply to a child blocked in `ask_parent` (see *Questions*). |
| `retry` | `name` | Recover a stalled child on its existing conversation (see *Stalls*). |
| `close` | `name` | End the child, free its slot. |

Limits: 6 open children, 16k chars per task, 24 KiB per final result.
Names are never reused within a session — including names that only exist as
hibernated records after a reload. Hibernated children hold no slot, and a spawn
that would exceed the cap reclaims the stalest finished child rather than failing
(see *Reaping*).

## Context inheritance

Delegation should not mean starting from zero. `context` controls what the child
inherits from your conversation:

- `forked` — a copy of your active conversation.
- `compacted` — an LLM summary of it, aimed at the child's task.
- `fresh` — nothing (project instructions still apply).
- `auto` *(default)* — `forked` while the copy would fit comfortably in the
  child's context window, `compacted` once it would not.

The unresolved tool call that spawned the child is trimmed, otherwise the provider
would reject the child's first request.

### Why `auto` prefers forking

The two options are not symmetric. Forking copies messages: no model call, no
latency, no loss — the child sees the same tool output and file contents the
parent reasoned over. Compacting costs one full summarization of the whole parent
conversation (up to 8k output tokens) *before the child process starts*, and it
is lossy exactly where a delegated implementation task is most sensitive: paths,
exact error text, the shape of a function.

So `auto` forks by default and compacts only when a copy would not leave the child
room to work. The rule is `tokens ≤ 60% × contextWindow`, read from
`ctx.getContextUsage()` — the only thing that actually constrains a fork. Above
that a forked child would start close enough to its *own* compaction threshold to
spend the budget re-summarizing anyway, at which point paying once here and
handing over a purpose-written summary is strictly better. When no token estimate
is available (before the first response, or right after a compaction) it falls
back to a message count, generously: 120, not the 14 it used to be.

When `auto` does compact, the summary is **cached against the parent's leaf entry
id**, so fanning out N agents from one point in the conversation summarizes once
rather than N times. The cache holds one entry, lives in memory only, and misses
as soon as the leaf moves — a stale summary is worse than a slow one.

A spawn reports each of these steps through `onUpdate` (`progress.ts`), because
the summarization is slow enough that silence reads as a hang.

### What a fork does not copy: signed thinking blocks

Anthropic returns extended-thinking blocks with a cryptographic signature over
the reasoning (pi-ai keeps it as `thinkingSignature`), plus safety-redacted
thinking as an opaque encrypted blob in the same field. `anthropic-messages.js`
passes both straight back to the API on the next turn — that is what they are
for. A fork moves those blocks into a different session, a re-seeded message
list and possibly a different model (`spawn({model})` allows any), where the
signature no longer corresponds to anything.

So `seedChildSession` strips them: `redacted_thinking` always, and `thinking`
with a non-empty signature unless the message names a provider we are confident
does not verify one. Unsigned thinking is kept — there is nothing to verify, and
it is the readable part. Provider detection **fails closed**: a message with no
recorded provider is treated as possibly-Anthropic, because being wrong that way
costs a forked child some reasoning text, while being wrong the other way costs
it a 400 on its first turn.

We deliberately do **not** also force the child's thinking level off. That is
only needed if a *later* request would be malformed without the stripped blocks,
and it cannot be: Anthropic requires thinking to be preserved for an assistant
turn whose `tool_use` is still awaiting its result, and `forkableMessages`
already trims exactly that turn. Every tool call the child inherits is resolved.
The child's own turns produce their own signatures, in its own session.

## Shared notes

All children and the parent share one scratchpad. Children get `shared_notes`
(read/append) and the path is in their system prompt; the parent uses
`subagent { action: "notes" }`. This is how sibling agents agree on an interface
without routing every word through the parent.

Location: `~/.pi/agent/subagents/sessions/<parent-session-id>/SHARED_NOTES.md`

## Child → parent messages

Children get a `report_to_parent` tool for material interim findings (a blocker, a
decision others depend on), and `ask_parent` when they need an answer before they
can continue. Reports, questions and final results land in one mailbox — bounded
for reports only; everything else is never dropped.

### One table decides what is mailed, and when

`transitions.ts` is the single source of truth: **every** agent status change
goes through `mailForTransition(status, cause)`, which returns which `MailKind`
is published (or `"silent"` *with a written reason*), whether the registry is
rewritten, and when the mail is delivered. Run `/agents mail` to print it.

The shape of the file is the point. It is a `Record<AgentStatus, …>`, so adding
a status without deciding its mail does not compile; `wakesParent` in `notify.ts`
switches exhaustively over `MailKind` with a `never` default, so adding a kind
without deciding whether it wakes does not compile either. A deliberate silence
is an *entry carrying a reason*, never an absence.

This exists because of a specific bug. A stall was detected, shown in the human's
UI, and never mailed to the orchestrator — the human watched a warning appear and
relayed it by hand. The first attempted fix added a wake rule for a kind that did
not exist and that nothing published: dead code that looked like a fix. Three
things were missing (the kind, the publish, and a rule in `orchestrator.md`), and
enumerating kinds harder in one of the three found none of the others.

Because this project has no type-checker in its test loop, `tests/transitions.test.ts`
re-derives the `AgentStatus`, `TransitionCause`, `DeliveryTiming` and `MailKind`
unions **from the source text** and checks the same properties at runtime. The
`never` assertions are real but nothing runs them; the runtime checks are the
enforcing half.

### Delivery never waits for a human

Publishing was always unconditional; delivery was not. Mail that did not wake an
idle parent "rode into the next request" — and the next request only exists when
a **user types**. At depth 1 that is a delay. Under nesting it is fatal: a
grandchild's parent is itself a `pi --mode rpc` process with no terminal and no
human, ever, so its queue was never drained at all and the tree silently stopped
working below depth 1.

So each kind carries a delivery timing, and only one of them involves a person:

| timing | when it arrives | kinds |
| --- | --- | --- |
| `immediate-steer` | steered into the running turn, between tool calls | `question`, `stall` |
| `at-turn-end` | when the current turn settles, or now if idle | `final`, `error`, `hibernated`, `restored`, `resumed` |
| `next-request` | rides along with whatever the parent is next given | `report` |

`immediate-steer` is for mail meaning something is **stopped**: a blocked or
stalled child does not get better while the parent works, and a turn can run for
minutes. `at-turn-end` is the default for everything else actionable — a turn
always ends, so it drains with nobody watching.

`onFinish: "notify"` decides whether a result may *interrupt* an idle parent. It
does **not** decide whether the result is ever handed over: reading it that way
is how it used to strand results forever. A parent with no UI ignores it
entirely, because there is no human there to have expressed a preference.

**Interim reports never wake anything.** A chatty child would otherwise start a
parent turn every few seconds, which is the opposite of "spawning does not block
you". That constraint is about `report`'s *volume*, not about a human being
present — it holds identically in a headless nested parent. Reports show up as a
toast, an unread marker (`●`) in the switcher and a count in the footer, and ride
out with whatever goes next.

Every final result and error card ends with a line the *harness* writes, outside
the nonce fence:

```
Decide "reviewer"'s fate now: close with subagent{action:"close",name:"reviewer"}, or keep it for follow-up work and say why.
```

The decision belongs in front of the model at the moment it reads the result,
not in a rule it has to remember. It sits outside the fence because everything
inside one is declared data — otherwise a child could author a line closing a
sibling.

Set `"onFinish": "notify"` to turn waking off entirely and keep the old
notify-only behaviour.

The mailbox drain is destructive, so both delivery paths go through one function
(`takeMail` in `notify.ts`): no result is ever delivered twice, and a delivery
that fails puts its mail back.

Delivered mail is wrapped in a `<subagent-NONCE …>` fence with a fresh random
nonce per delivery, so a child cannot close the block and forge one attributed
to a sibling.

## Questions (`ask_parent`)

A child that hits a decision genuinely belonging to the parent can ask instead of
guessing. It calls `ask_parent`, and **keeps its place**: the tool blocks, and
when the answer arrives the child continues *in the same turn* with everything it
was holding still in context.

The mechanism is the interesting part. A tool result only reaches the parent at
`tool_execution_end`, so a child that *returned* its question would have ended
its turn to ask it — losing the context the question is about. Instead the tool
announces through `onUpdate`, which pi forwards as `tool_execution_update` with
`partialResult` intact, so the parent learns of the question while the call is
still open. The child then polls `<sessionDir>/answers/<questionId>.json` until
the parent writes it (atomically, tmp + rename). A file rather than an RPC
message, so an answer still lands if the parent reloaded and revived the child in
between.

Answer with `subagent {action: "answer", name, message}`. If that agent has no
question outstanding the text is delivered as an ordinary follow-up rather than
dropped.

**There is no timeout — on the child side.** A guessed answer is worse than a
slow one, and with hibernation a blocked child is recoverable rather than lost.
The asymmetry is the safety property: the parent's half of the protocol is only
ever *write a file* and *publish mail*, and **nothing on the parent side ever
awaits a child's answer**. If it did, two agents would be waiting on each other
with no timeout on either side. `interrupt`, `close`, `answer` and the sweeps
all return promptly against a child that is genuinely blocked; that is asserted
against real processes in `tests/ask-liveness.test.ts`.

The corollary is that the parent *forgetting* a question would strand the child
forever, so the child re-announces every 30s while it waits. The manager ignores
a re-announcement of a question it still holds, and picks one up again if it had
lost it (reload, revive, interrupt). Symmetrically, the parent drops a pending
question the moment it can no longer be served — on child exit, interrupt,
hibernate, retry or close — rather than leaving the footer asking for an answer
no process will ever read.

That visibility is non-negotiable, so a blocked child is:

- `waiting` (`❓`) in the strip, with its row showing the question rather than the
  tool call it made before asking;
- banner-lined above the switcher (`❓ 2 subagents blocked on your answer: …`);
- the state that wins the badge's **tone** on the border bar (`warn`, outranking
  even a failure — see *This extension's own chip*), and counted **first** in the
  footer sentence that is its fallback (`subagents: 1 waiting for you, 2
  running`), which is why that sentence is ordered by urgency: it shows the two
  most actionable states and folds everything else into `+N more`, so truncating
  it can never drop the part that wants a human;
- reported by `list` and `read`, and mailed to the parent the moment it is asked;
- explicitly **not** treated as a stall. Both are silence, but a stall means the
  network died and a question means the parent has not replied; conflating them
  sends you to check your wifi when what is needed is an answer.

### Queueing is a guarantee; delivery timing is not

For a child, asking is blocking and unbounded, so the parent's queue is the only
thing standing between a question and a permanently stuck agent. A question is
therefore **queued the moment it is asked**, unconditionally — never dropped,
never coalesced, and exempt from the mailbox bounds that trim interim reports.

Whether the parent is idle affects only *when* it is handed over:

- **idle** → delivered immediately, waking the parent so it can answer by itself;
- **busy** → rides into the next request via `before_agent_start`, and re-offers
  itself at `agent_settled` so it lands the moment the turn ends rather than
  whenever the human next types.

Several children can be blocked at once. Each queued question carries its agent
name and question id, queue order is preserved, they ride together as distinct
entries, and answering one leaves the others untouched.

## Personas

Optional markdown files in `~/.pi/agent/agents/*.md` (and `.pi/agents/*.md` for
trusted projects when `projectPersonas` is on):

```markdown
---
name: reviewer
description: Reviews a diff and reports blocking issues
tools: read, grep, find, ls, bash
model: anthropic/claude-sonnet-4-5
context: fresh
---
You review the change in your working directory...
```

Without a persona a child inherits your model, thinking level and tools.

Optional `context:` sets the persona's default context mode — one of `fresh`,
`forked`, `compacted` or `auto` — for spawns that don't pass their own `context`.
Precedence: **spawn param > persona frontmatter > `auto`**. An unknown value is
ignored (the persona still works, falling through to `auto`).

In `tools:` a `"*"` (the Claude Code convention) means "inherit everything":
pi's tool allowlist matches literal names, so a `"*"` reaching it would leave
the child with no tools. Any `"*"` in the list — alone or alongside names —
removes the restriction entirely; names listed next to a `"*"` are ignored,
since the star already granted them.

`model:` frontmatter sets the persona's default model the same way: precedence
is **spawn param > persona frontmatter > your model**, so a persona can make
its children cheap (recon on a fast model) without the parent passing `model`
at all. The bundled `orchestrator.md` tells orchestrating parents to match the
model to the weight of the work — see its "Matching the model to the work"
section.

## Worktrees

**This extension knows nothing about git, jj, or worktrees.** A child just takes a
`cwd`. Creating that directory is a project-level concern, described in markdown:

- the `delegate-worktree` skill (`~/.agents/skills/delegate-worktree/`)
- a `## Worktrees` section in the project's `AGENTS.md` naming the command

That keeps `mk-worktree.sh`, plain `git worktree add`, or `jj workspace add`
interchangeable without touching this code.

## Orchestrator mode

So the main loop defaults to delegating:

- `nudge` *(default)* — appends orchestrator guidance to your system prompt:
  delegate implementation, prefer reading/planning/coordinating here.
- `strict` — additionally blocks `edit`/`write` in the parent conversation.
- `off` — nothing.

Toggle with `/agents orchestrate off|nudge|strict` (persisted).

The guidance text itself lives in `orchestrator.md` next to the code, re-read every
turn so edits apply immediately. One file in `~/.pi/agent/` shapes what is
injected — `orchestrator.md` there too: the same concept in two homes, the user
copy in the agent directory naming the role this parent plays, the bundled copy
next to the code carrying the mechanics. The user copy, also re-read every
turn, is **prepended** to the bundled guidance, joined with a blank line:
your identity and delegation judgment first, the framework mechanics (stall
response, reaping, anti-double-work) always after — current with the code, never
copied, never drifting.

What belongs in it is the layer the bundled prompt cannot know: role identity
("you are patchbay"), delegation policy ("never run scribe and integrator
together"), standing instructions for how lanes are briefed ("tell every lane
about collisions and assumptions to verify"). Absent or whitespace-only, it
contributes nothing and the bundled prompt is used as-is.

```markdown
<!-- ~/.pi/agent/orchestrator.md -->
You are the patchbay. Brief every lane with: the fence, the assumptions to
verify, and the sibling lanes it may collide with.
```

The bundled guidance includes matching each child's model to the weight of
its work — the `model` spawn param and persona `model:` defaults (see
"Personas") are how the orchestrator spends cheap on simple tasks without
giving up strength where it matters.

## UI

A subagent conversation is just another llm chat, so it is rendered with pi's own
chat components — the same `UserMessageComponent`, `AssistantMessageComponent` and
`ToolExecutionComponent` the main chat uses. Markdown, tool blocks and their
expand/collapse behaviour are identical, and nothing is ever appended to the main
chat.

**The tool row itself** (`render.ts`): `subagent` supplies `renderCall` and
`renderResult`, following the shape pi's own built-ins use — a pure
`(args, theme) => string` formatter wrapped in a `Text` that reuses
`context.lastComponent`. Without them pi falls back to a bold tool name in the
error-styled shell, so every action looked identical and the delegated task was
never shown. A `spawn` row leads with the name, persona, model, context mode and
cwd and then **quotes the task**: it is a prompt being handed to another process
with your credentials and your working tree, and it should be auditable at a
glance. Collapsed shows the first 3 lines (240 chars); `ctrl+o` shows it whole.
`followup`/`message`/`answer` quote the message the same way. Errors stay in the
`error` slot and are never clipped — *why* a spawn failed is the entire row.

**Switcher** (below the editor): one line per child — index, unread marker,
status, name, elapsed, turns, cost, latest activity — then a selectable strip of
every chat, the main conversation first:

```
● main │ ◐ nav-ping │ ✓ reviewer●
```

Status icons: `◐` running · `❓` waiting for your answer · `⚠` stalled · `✓`
completed · `✗` failed · `⊘` interrupted · `☾` hibernated · `·` idle.

**Footer status**: `subagents: 1 running, 2 done (1 unread)`, set with
`ctx.ui.setStatus`. It persists — unlike a toast, which is gone by the time you
look up.

**Reaching the strip**: press `↓` out of an **empty** input box. With any text in
the buffer `↓` is cursor-down and newer-history exactly as usual; the empty-buffer
restriction is deliberate so history browsing is never stolen. `ctrl+←/→` used to
switch chats and is gone (macOS binds it to Spaces), and so is `ctrl+g` (it is
pi's own `app.editor.external`). No key outside the strip and the pane belongs to
this extension.

| Key (strip focused) | Action |
|---|---|
| `←` / `→`, `tab` / `shift+tab` | move the selection (wraps) |
| `enter` | open that chat — `main` returns to the main conversation |
| `↑` / `esc` | back to the input box |
| any printable key | back to the input box, and it types that character |

**Chat pane** (`/agents <name>`, or `enter` on the strip): a full-screen view of
one child. There is deliberately **no shortcut key**: `ctrl+g` used to open it and
shadowed pi's own `app.editor.external` binding, so it was removed.

| Key | Action |
|---|---|
| `tab` / `shift+tab` | next / previous chat (wrapping past either end to the main chat) |
| `←` / `→` | same, while the input box is empty |
| `↓` | into the switcher strip, while the input box is empty |
| `pgup` / `pgdn`, `shift+↑` / `shift+↓` | scroll |
| `↑` | scroll up one line, while the input box is empty |
| `home` / `end` | top / follow the live end (input box empty) |
| `enter` | send to this child — steers it mid-turn, prompts it when idle |
| `esc` | leave the strip, or (from the input) back to the main chat |

`esc` is layered on purpose: while the strip has focus the first `esc` only
leaves the strip, and a second one interrupts a streaming agent. Escaping out of
a selection should never also stop work.

Focus on the strip is **cooperative**: pi has no public way to hand terminal
focus to a widget, so the editor keeps input ownership and forwards keys while
the strip is active. The main editor is wrapped via `ctx.ui.setEditorComponent`
with a `CustomEditor` subclass, which is what keeps every app keybinding
(interrupt, ctrl+d, model switching, extension shortcuts) working.

### The badge bar in the editor border

Owning the editor comes with a duty to everyone else, because
`setEditorComponent` is a **single slot**: the last extension to call it wins,
silently. So no other extension can draw in the input box, and the border around
it — a full-width rule that was otherwise empty, directly around where the user
is already looking — is prime unused space. This extension therefore renders a
bar there on everyone's behalf:

```
────────────────────────────── mcp  3/4  27 tools  1 failed ───
│ what does this look like?
```

Of the four corners it takes the **top right**, and both halves are deliberate:

- **Top**, because the bottom rule is the last thing between the input and the
  footer, and stacking a second row of status information there rebuilds the
  crowding the bar exists to relieve. The top rule separates the input from the
  transcript, so a bar there reads as a header for the box.
- **Right**, because the left edge of the box is where the text starts and where
  the eye tracks while typing — and because pi's scroll indicator is anchored
  hard left. Wanting different columns is what lets the two share a line.

Publishers put badges in `extensions/shared/border-badges.ts` and never touch the
editor; this extension knows nothing about what the badges mean. The layout lives
in `badge-bar.ts`, pure and free of pi imports, so every width decision is
testable without a terminal.

The alignment maths is one derived variable. Reading the line right to left it is
`leading │ gap │ chips │ gap │ ───`, and
`leading = width - 2*SIDE_GAP - used - TRAIL_RULE`, so the terms sum back to
`width` by construction. Keeping `used` inside
`budget = width - MIN_LEAD_RULE - 2*SIDE_GAP - TRAIL_RULE` is the same statement
rearranged into `leading >= MIN_LEAD_RULE`.

Four things the implementation has to get right:

- **It shares the line with the scroll indicator rather than yielding it.** pi
  replaces a border with `─── ↑ 3 more ───` when the input is taller than the
  box. That is anchored left and the badges are anchored right, so the lookup
  hands the indicator back as a prefix to preserve and the bar composes into the
  columns after it:
  `─── ↑ 13 more ────────────────── mcp  2/2  🤖 2 ───`. Two rules make that
  safe. The prefix is **re-themed, never sliced** — pi paints the whole indicator
  with one `borderColor` call, and cutting a themed string at a column boundary
  means cutting inside an escape sequence. And when the residual width will not
  hold even one chip the composer returns `undefined` and the indicator keeps the
  whole line, because `MIN_LEAD_RULE` is what stands between the two: there is no
  separate collision check, since there cannot be a bar without that gap. Losing
  "3 more" would be a worse trade than losing badges.
- **It matches the rule, it does not index to it.** The target is found by
  **exact string match** against `borderColor("─").repeat(width)`, scanning from
  the requested end — `lines[0]` is the top border only for as long as pi never
  prepends anything, and the same scan from the other end skips the autocomplete
  rows drawn *below* the bottom border. Which end to search is a parameter
  (`borderSlot(lines, plainRule, "top" | "bottom")`), not a second copy of the
  scan, so the two directions cannot drift apart.
- **Width is `visibleWidth`, never `.length`.** A themed rule carries escape
  sequences per character; counting them as columns produces a line wider than
  the terminal, which wraps and corrupts every frame after it.
- **Repaint is a subscription, not a timer.** The editor subscribes to the
  registry and calls `tui.requestRender()`; an unchanged republish notifies
  nobody, so a chatty publisher cannot redraw the editor on every heartbeat.
- **It degrades in both directions.** Too narrow, and trailing badges are dropped
  with a `…` that is never itself dropped silently. No colour in the theme, and
  the chips join with a visible ` · ` instead of relying on backgrounds — the
  border has no whitespace-collapsing rule, so it can afford a nicer fallback
  than pi's footer can.

#### This extension's own chip: `🤖 2`

It publishes into the same registry as everyone else rather than special-casing
itself, and its chip is a glyph and a count — no `subagents:` label, because the
bar is shared and nine columns of prose is nine columns somebody else does not
get. The robot *is* the label.

The state that `subagents: 1 waiting for you, 2 running` used to spell out is not
thrown away; it **moves channel**. The count goes in the text and the state goes
in the tone:

| tone | when | why |
|---|---|---|
| `warn` | anything `waiting` | You are what is missing. `ask_parent` has no timeout, so it stays stopped until somebody answers — this outranks a failure, which has already finished happening. |
| `error` | `stalled` or `failed` | Broken, wants investigating. |
| `pending` | everything in flight is still `starting` | A spawn can spend a whole summarization before its child exists; `ok` there would claim work is under way when none is. |
| `ok` | anything actually running | |
| `neutral` | anything `completed` | "Information to read": the result you delegated for, still needing a close-or-keep decision. |
| `muted` | only idle / hibernated / stopped | "Information to be able to ignore." |

Unread mail gets a **second** chip (`● 3`) and only while it is non-zero, so the
ordinary case stays one chip. It is not folded into the tone because unread is
not a state of the agents: overwriting "one of these is blocked on you" with "you
have mail" would lose the more urgent of the two, and mail drains by itself while
a blocked child does not.

**On `🤖` being two cells wide.** `visibleWidth` reports 2, correctly — it is East
Asian Wide — and the whole bar's padding derives from that, so a test pins the
value rather than trusting it across a pi-tui upgrade. That `🤖` also has
`.length === 2` is a coincidence of it being a bare surrogate pair and is pinned
*with its counter-examples* (`❓` is length 1 and width 2; a ZWJ sequence is many
code units and width 2), so nobody "simplifies" the composer to `.length` later.
The residual risk is a terminal that advances the glyph by one cell anyway, which
no process can detect — the layout is arranged so that error can only lean the
safe way. Right alignment does not change that conclusion, but it does change the
argument, so it is worth re-deriving rather than assuming it carried over from
the left-aligned version: `visibleWidth` reports the Unicode **maximum**, so the
measured width of the chips is an over-estimate; the leading rule is
`width - … - used - …`, so `used` enters it *negatively* and over-estimating it
makes the leading rule shorter. Moving the filler from the right of the chips to
their left does not flip that sign, because both layouts derive the filler by
subtracting `used` from `width`. So such a terminal renders the line *short*,
leaving a one-column gap before the right edge, rather than one column long,
which would wrap and corrupt every frame after it.

The other direction matters too: **a publisher must not lose its indicator when
nothing is rendering.** The editor announces itself with `setRenderer(true)` on
mount and gives the vote back on dispose, and publishers check `hasRenderer()`
before deciding to skip their own status line. Disable this extension and mcp's
footer entry comes straight back. Presence is a *count* rather than a flag,
because across a reload the incoming editor is constructed before the outgoing
one is released, and a flag would let the old instance switch the bar off for
everybody.

`EditorComponent` has no teardown hook — nothing tells an editor it has been
replaced — so `index.ts` keeps the instance and calls `dispose()` itself, both
when a replacement is created and at `session_shutdown`. `dispose()` is
idempotent for exactly that reason.

Opening a pane replays the child's session file, then follows its RPC event
stream live: text streams in token by token and tool blocks fill in as they run,
exactly as if you were watching the main agent. Panes keep their scroll position,
so switching is instantaneous and lossless.

`/agents notes` shows the shared notes in the same full-screen overlay.

Two deliberate deviations from the main chat: images are not rendered inside the
pane (terminal image escapes cannot be composited into an overlay), and the
viewport is scrolled by the pane itself — see below.

### Platform constraints (verified against pi's TUI source — do not re-litigate)

Two things about overlays are settled. Both were re-derived the expensive way
once already; the findings are recorded here so the next person does not.

**1. There is no root-tree or scroll-region API. Manual viewport slicing is the
intended approach, not a workaround.**

`TUI.compositeOverlays()` renders an overlay with a bare `component.render(width)`
and slices the result to `maxHeight`. The layout pass that drives
`ScrollView.updateLayout()` runs only over the *root* component tree, so a
`ScrollView` placed inside an overlay renders its full content and never
scrolls. `ExtensionUIContext` exposes only `custom`, `onTerminalInput`,
`setEditorComponent`, `setWidget`, `setStatus` and the dialogs — `chatContainer`
and `editorContainer` are private fields of `InteractiveMode` and are never
handed out. So the pane slices its own lines (~15 lines in `chat-view.ts`
`render`) and everything *inside* the viewport stays a real pi component.

For what it is worth, the other public pi subagents extension reaches the same
place independently: no `ScrollView` anywhere in its ~5k-line TUI, and a manual
`body.slice(scroll, scroll + viewportHeight)`.

**2. `onTerminalInput` cannot be used to win scroll keys. Focus is the only
mechanism.**

`ctx.ui.onTerminalInput` maps to `TUI.addInputListener`, and pi's alt-screen
transcript scroller is registered as an input listener too — at TUI
construction, i.e. *before* any extension. `TUI.handleTerminalInput` runs the
listener chain first and stops on the first `{consume:true}`, and only then
dispatches to the single focused component:

```
TUI.handleTerminalInput
  1. inputListeners, in insertion order  (tui.js:560)   ← alt-screen scroller lives here
  2. focusedComponent.handleInput        (tui.js:616)   ← overlays live here
```

So `pageUp` is consumed at step 1 and an overlay never sees it. **Claiming scroll
keys inside the overlay's `handleInput` cannot work** — there is nothing left to
claim.

The supported escape hatch is focus. The scroller checks
`shouldDeferViewportInputToOverlay()` (`tui-alt-screen.js:378`) before every
scroll binding, which is `isOverlayFocused()`: true only while the focused
component *is* a visible overlay. `showOverlay` focuses the overlay at open, so
this works — until something takes focus back. Roughly two dozen call sites in
`interactive-mode` end with `this.ui.setFocus(this.editor)` (dialog dismissal,
selector close, `setEditorComponent`, ambient auth, the reload box, loaders);
none of them know an overlay is up. When that happens `pageUp` scrolls the
**main** transcript underneath the pane, which reads as "my subagent chat is
showing the wrong history".

`keepFocus` in `chat-view.ts` is the fix: it reasserts focus whenever it notices
focus has moved while the overlay is mounted, and it inserts its observer at the
**front** of the listener chain (the chain is a `Set`, so the existing listeners
are re-added behind it) because otherwise the scroller's `{consume:true}` would
return before the observer ran. It deliberately yields to any *other* overlay
that holds focus, so a real modal stacked on top of the pane still gets the
keyboard. `nonCapturing` is deliberately **not** passed to `showOverlay` — that
flag opts out of the very focus this depends on.

Regression coverage is in `tests/focus.test.ts`, which drives the real
`TuiAltScreen` rather than a mock, since the entire question is what pi's own
machinery does with focus.

## Configuration

`~/.pi/agent/subagents.json`:

```json
{
  "orchestrate": "nudge",
  "projectPersonas": false,
  "onFinish": "wake",
  "stallSeconds": 120,
  "idleHibernateMinutes": 30,
  "autoResume": true,
  "autoResumeMaxAgeMinutes": 60,
  "maxResumeAttempts": 3,
  "autoRestoreMaxAgeMinutes": 1440,
  "childDeny": ["mcp", "slack-approval"]
}
```

`onFinish` is `"wake"` (default) or `"notify"`: whether a final result or an
error may *interrupt* an idle parent by starting a turn. It does **not** control
whether the result is delivered — with `"notify"` it still arrives when the
current turn ends, and a parent with no UI ignores the setting entirely, because
nobody is there to hold the preference. See *Child → parent messages*.

`stallSeconds` is how long a busy child may stay silent before it is reported as
stalled; `0` disables the check.

`idleHibernateMinutes` is how long a completed child may sit untouched before its
process is stopped and it is hibernated; `0` disables the sweep.

`autoResume` (default `true`) restarts children that a reload or a crash stopped
**mid-task**; finished children are never restarted. `autoResumeMaxAgeMinutes`
(default 60, `0` disables the bound) limits how stale interrupted work may be and
still restart itself at a cold start — a reload resumes regardless of age.
`maxResumeAttempts` (default 3, `0` disables the cap) stops a crash loop. See
*Interrupted work resumes itself*.

`autoRestoreMaxAgeMinutes` (default 1440, i.e. a day; `0` disables the bound) is
the *other* half: how stale the previous run's children may be and still be
adopted back into a cold start automatically. Adopting starts no process, so the
bound is about clutter rather than tokens — without it a registry full of
leftovers resurrects the same pile at every launch. See *A cold start takes its
own work back*.

`childDeny` lists the extensions a child must **not** inherit, by discovery name
or absolute path: see *What a child inherits*. Add `"subagents"` to stop children
spawning children of their own.

> **Removed:** `childExtensions` (an allowlist, from when children ran with
> `--no-extensions`) and `childMcp` (superseded by `childDeny`, which denies MCP
> like anything else). Both are ignored rather than rejected, so an existing
> config file keeps working and can be cleaned up whenever.

## What a child inherits

**A subagent is the same agent as you, elsewhere.** Children run with **normal
extension auto-discovery**, so they get your providers, your rendering, your
keybindings — whatever you have configured. The previous design (`--no-extensions`
plus a hand-maintained allowlist) meant children silently lost your configuration
and the allowlist rotted as soon as you added an extension.

This extension is inherited too, so a child gets the `subagent` tool and can
delegate in turn. What it does **not** inherit is the *user interface*:

| Guard | Where | Effect |
|---|---|---|
| `PI_SUBAGENT=1` | `subagents/index.ts` | No widget, no editor component, no footer status, no `/agents`. The tool stays. A child has no terminal of its own, so painting into one would be painting into somebody else's. |

Put `subagents` in `childDeny` to opt a project out of nesting entirely.

The child's own tools (`report_to_parent`, `shared_notes`, `ask_parent`) come
from `child-extension.ts`, still passed explicitly with `-e`.

## Liveness: pi must always be interruptible

**An extension must never be able to make pi uninterruptible.** Extension
handlers — tool `execute`, command handlers, event listeners — run on the same
turn that Escape and `/reload` need in order to finish, and the only lever pi has
to cancel one is `ctx.signal` (or the `signal` a tool receives). An `await` that
neither observes that signal nor has a deadline of its own does not merely make
pi slow: it makes the session unrecoverable without killing the terminal.

That happened. A `subagent {action:"interrupt"}` call awaited
`ChildRpc.abort()`, whose response promise had neither a deadline nor a
cancellation path. The child accepted the abort and never answered; pi reported
busy, Escape did nothing, `/reload` would not run, and every running subagent was
lost with the terminal. (The acknowledgement would not even have meant what the
await implied: an RPC response says the abort was *accepted*, not that the child
stopped — the stop arrives later as `agent_settled`.)

The rule the code now follows, stated at the top of `rpc.ts` and `manager.ts`:
every await must **observe a caller `AbortSignal`**, **carry its own deadline**,
or preferably both. A signal alone is not enough, because handlers that run
outside a turn (the housekeeping timer, `session_shutdown`) get no signal at all.

In practice:

| Layer | Bound |
| --- | --- |
| `ChildRpc.send` (and so `prompt`/`steer`/`followUp`/`abort`) | Every request takes `{signal, timeoutMs}` and is clamped to `DEFAULT_REQUEST_TIMEOUT_MS` (10s). A caller cannot opt out of the ceiling. A timed-out request is forgotten; a late response is dropped rather than mis-routed. |
| `ChildRpc.start` | Honours a signal, and stops the process it started if the caller gave up. |
| `ChildRpc.stop` | SIGTERM to the child's **process group**, then SIGKILL, then a hard give-up. Idempotent; cannot hang. |
| `ChildRpc.consume` | The pending (newline-less) read buffer is capped at 16MB. A child cannot grow the parent's heap without limit. |
| `manager.interrupt` | **Synchronous.** The abort is dispatched fire-and-forget; a missing acknowledgement is recorded on the agent's activity feed, not awaited. |
| `spawn` / `send` / `retry` / `revive` | Signal threaded from the tool call; the summarization model call, pi's extension discovery and the session seeding each carry a deadline on top. |
| `close` / `stopAll` / `hibernateAll` / the idle sweep | Bounded best-effort sweeps. `hibernateAll` snapshots its records *before* stopping anything, so a hung teardown cannot cost you your children on reload. |
| `ask_parent` | The one deliberately unbounded wait, and it lives entirely on the **child** side of the process boundary. |

A deadline firing always means something upstream is wrong, so it is not
swallowed: `onDeadlineExceeded` reports it and the extension raises a warning
notification (once per distinct operation). A backstop that trips silently is how
this bug survived a code review.

The regression tests are `tests/cancel.test.ts` (fake transports, plus one real
never-responding process) and `tests/ask-liveness.test.ts` (real processes on
both ends). Each asserts a wall-clock bound rather than merely awaiting, because
the failure mode under test is "never settles" — a suite that hangs reports
nothing at all.

### A child cannot exhaust the parent's memory

`consume()` buffers stdout until it sees a newline, so an unterminated line is
unbounded growth in the **parent**. `MAX_PENDING_LINE_BYTES` (16MB) caps it: on
breach the client is failed exactly as if the process had died — every in-flight
request rejects, the exit listeners fire, the manager replaces it — with a
diagnostic quoting the byte count and 200 characters from each end of the
offending data. We fail loudly rather than truncate, because a silently cut frame
surfaces later as an unexplained parse failure with no route back to the cause.
The cap is only checked *after* draining complete lines, so any amount of
well-formed traffic passes, however it happens to be chunked.

### Closing a subagent kills what it started

Children are spawned `detached` (except on Windows, which has no process groups),
so each gets its own group and `stop()` signals `-pid` rather than `pid`. Without
that, a subagent that ran `npm test`, `tsc --watch` or a dev server leaves those
grandchildren running after the agent is closed and after pi quits — which
defeats the point of closing it. `process.kill(-pid, …)` falls back to
`child.kill(…)` if the group is already empty or unsupported.

The trade-off is that a detached child is no longer in the terminal's foreground
process group, so Ctrl+C in pi's terminal no longer reaches it and SIGTERM from
`stop()` becomes the only way it dies. That is already bounded — `stop()`
escalates to SIGKILL and then gives up on its own timer — and interactive
cancellation was never signal-based: it goes through `abort()`, an ordinary RPC
command.

`tests/rpc.test.ts` covers both, including a stub subagent that really does spawn
a grandchild and a real assertion that the grandchild is gone after `stop()`.

## Identity

**A subagent is identified by its session uuid, not by its name.**

Names are chosen by the spawning model and are only reserved inside one parent's
manager, so as soon as one subagent can spawn another, two parents can each have
a `reviewer`. Anything keyed on a name — mail, pending questions, hibernation
records, the registry — becomes ambiguous the moment that happens.

Every pi session already has a uuid. `context.ts` seeds a child's session header
with its own `id` and its parent's session file, and the parent records that uuid
at spawn, so both ends know both ids and the relationship is *explicit* rather
than inferred:

| Question | Answered by |
|---|---|
| Am I booting inside a subagent? | `PI_SUBAGENT=1` — a **boot flag**, one bit, no identity |
| Which agent am I? | `sessionManager.getSessionId()` |
| Whose child am I? | `getHeader().parentSession` — a *session fact* |
| Which child is `reviewer`? | resolved to a uuid **locally**, inside one parent |

The boot flag exists for exactly one reason: the UI guard runs inside the
extension factory, *before* a session exists, so it genuinely cannot ask the
session. It gets one bit and nothing else. `PI_SUBAGENT_NAME` is still passed,
but purely as a **label** — it names log lines and the author field of a
shared-notes entry, and nothing keys off it.

See `identity.ts`.

## Lifecycle

Children never outlive the parent process: no agent keeps editing a worktree
after you quit. If a child dies on its own — crash, OOM, an external `kill` —
the parent notices the process exit, marks the agent failed with the child's
stderr attached, and mails that to you instead of waiting forever.

Closing an agent deletes its session directory under
`~/.pi/agent/subagents/sessions/<parent-session-id>/`, except for a failed one:
its transcript is the only post-mortem evidence there is, so it is kept.

### Reload survives (hibernation)

`/reload` used to kill every child. Now only **quitting** does.

`session_shutdown` carries a reason. For `reload`, `resume`, `fork` and `new`,
every live child is written into the parent's own session with `pi.appendEntry`
(name, task, persona, cwd, model, context mode, session file and dir, usage,
status) *before* the processes are stopped, and the processes are then stopped
concurrently under a ~1.5 s deadline — so the reload is fast as well as
non-destructive.

On the next `session_start` those records are read back and the agents reappear
as `hibernated` (`☾`): in the strip, in the footer, and with their chat panes
fully readable, because the child's `session.jsonl` is untouched on disk.

Sending anything to a hibernated agent (`followup`, `message`, or typing in its
pane) **revives** it: a fresh `pi --mode rpc` on its *existing* `--session` file,
so the child resumes with its whole conversation and no context is lost. Nothing
is re-seeded — the session already exists.

Hibernated agents do not hold a process slot, so a reload with six children does
not lock you out of delegating. `close` works on them exactly as before.

### Interrupted work resumes itself

"Hibernated" covers two states that want opposite treatment:

- a child that **finished**, whose process the idle sweep reclaimed. Waking it
  would redo work that is already done.
- a child that was **still working** when a reload or a crash took its process
  away. Nobody decided to stop it. Left alone it is work stranded on disk
  indefinitely — which is not hypothetical; it happened to a real agent here.

The second case now restarts itself: revived on its existing session file and
re-prompted to continue, with no human action and no orchestrator decision. The
first is left exactly where it is.

This is deliberately **framework behaviour and not a line in `orchestrator.md`**.
Everywhere else the fix for "the orchestrator does not do X" has been to add a
rule telling it to do X, and that works when X is a judgement. Resuming
interrupted work is not a judgement — there is one right answer and the model has
demonstrably not been taking it. Guidance is advice a model may decline.

Telling the two apart needs the status from *before* the process went away, so
`unfinishedStatus` is recorded at the moment of hibernation and carried on both
the session record and the registry node. `markDeadNodes` preserves it too: after
a `kill -9` the node still says `running`, and that is precisely the evidence.

Two edges, both settings:

- **Age** (`autoResumeMaxAgeMinutes`, default 60). A reload or session switch
  resumes regardless of age — the process was alive moments ago. A cold start
  (`kill pi && pi`) cannot know that, so it only resumes work younger than the
  bound; anything older stays behind `/agents restore`. Day-old work springing to
  life and editing files is a worse surprise than work left asleep.
- **Crash loops** (`maxResumeAttempts`, default 3). Attempts are counted **on the
  registry node**, written *before* the attempt, so the count survives the very
  restart it is counting — an in-memory counter resets every crash and retries
  forever. Past the cap the agent is marked failed and published as `stall`
  mail, because that is what it is: stopped work needing a decision, and the
  automatic recovery that would otherwise handle it is now off.

Set `"autoResume": false` to approve every revive by hand instead.

Auto-resume **starts processes**, so it is gated on the session having a UI. Note
that this is the opposite of the mail-delivery rule above, where `hasUI: false`
means "drain harder". Both follow from the same fact — nobody is watching — and
diverge because delivering a message costs nothing while spawning a process
commits real resources that a `--list-models` invocation would immediately
strand.

Only the newest hibernation entry counts, so an agent you closed between two
reloads stays closed. The entry also records which parent session wrote it: a
**fork** inherits the entries but does not claim the children, because the
session it forked from may still be running them and two parents reviving one
child would put two `pi` processes on one session file.

### Cold restarts survive too (the registry)

Hibernation records live in the parent's session file, which covers every case
where the *same* session is reopened. It structurally cannot cover the one people
actually do: `kill pi`, then start it again. A cold start opens a **new** session
and never reads the old one, so a whole tree of children is stranded — invisible
and unreachable, with their transcripts sitting on disk.

So there is a second record, outside any session:

```
~/.pi/agent/subagents/registry.json
```

```jsonc
{
  "version": 1,
  "rootSessionId": "…",
  "nodes": [
    { "sessionId": "…", "parentSessionId": "…", "name": "reviewer", "task": "…",
      "cwd": "…", "model": "…", "sessionFile": "…", "status": "running",
      "lastActiveAt": 0, "pid": 1234 }
  ]
}
```

Four properties carry the whole design:

- **Keyed by session uuid.** See *Identity* above.
- **Parentage is a field**, not a nesting level and not a directory layout, so
  arbitrary depth costs nothing: a grandchild is a node whose parent is a node.
- **Written on every lifecycle transition** — spawn, settle, hibernate, close —
  not only at shutdown. A `kill -9` runs no shutdown hook, so anything written
  only on the way out is missing precisely when it is needed. The worst case is
  a slightly stale registry; never an absent one.
- **Atomic and tolerant.** Writes are temp-file + `rename`, so a reader sees the
  whole old file or the whole new one. A corrupt, truncated or foreign file reads
  as *empty* and is replaced on the next write: a bad registry must never be able
  to stop pi from starting.

**Liveness comes from the pid, not the status.** After a crash every status in
the file is frozen at the moment of the crash and every one of them lies about a
live process, so on startup any node whose pid cannot be signalled is marked
hibernated. `quit` now checkpoints the registry before stopping the children
rather than discarding them.

#### A cold start takes its own work back

A cold start used to only **report**: a toast, plus a permanent `1 restorable
subagent` in the footer, with `/agents restore` left to the human. That caution
was aimed at the right danger and applied to the wrong act — **restoring starts
no processes**. It turns registry rows back into records in a list, which `close`
undoes. So the affordance was asking you to press a button whose only effect you
already wanted, on every launch, forever.

So the previous run's children are now simply back, and the footer entry is gone.
What is *not* automatic is as important:

- **Another directory's children.** One registry file describes every tree on the
  machine. Scoping is by `parentCwd` — the directory the *parent* was working in,
  recorded on every node — rather than by the child's own `cwd`, which under the
  worktree flow is deliberately somewhere else. Descendants come along with their
  seed, so a grandchild in a second worktree is not stranded.
- **Anything older than `autoRestoreMaxAgeMinutes`** (a day).
- **A child another pi is still driving.** Two windows on one repo share a
  directory, so scoping cannot tell them apart; a pid that survived
  `Registry.live()` can, and such a node is never adopted.
- **One-shot invocations.** `pi -p …` gets a `session_start` too, and folding
  somebody's agents into a single scripted turn is neither wanted nor observable.
- **Starting processes.** Adoption produces *records*; whether any of them gets a
  `pi --mode rpc` back is the separate, stricter decision in *Interrupted work
  resumes itself*.

Whatever is held back stays behind `/agents restore`, which is unchanged and may
reach across directories and ages — somebody asked for it.

The adoption is also **quiet**: one summary toast rather than one per agent, and
the `restored` mail rides into the parent's next request instead of waking it.
Waking would mean opening pi spends a model turn before you have typed anything,
which is the surprise the whole path is trying to avoid; nothing is running and
nothing is blocked, so the first real request is soon enough.

Reviving then uses the ordinary path — a fresh `pi --mode rpc --session <existing
file>` — so transcripts and conversations come back intact.

### Reaping

A finished child still holds one of six slots until somebody decides its fate,
and nothing used to ask. `/reload` hid that by wiping every agent; now that they
survive a reload, they would genuinely accumulate. Three mechanisms, all sharing
the rules in `reap.ts`:

1. **The orchestrator is asked.** Every final result carries the close/keep
   affordance above, and `orchestrator.md` tells the orchestrator to verify the
   work and then either close the agent or name the follow-up it is keeping it
   for. Keeping is genuinely cheap — a `followup` resumes the child's existing
   conversation, while a fresh `spawn` re-inherits parent context from scratch
   and pays for it again — so a named follow-up beats a respawn, and a vague
   "might need it" beats nothing.
2. **Idle hibernation.** A `completed` child untouched for
   `idleHibernateMinutes` (default 30) hibernates itself: process stopped,
   conversation and record kept, revivable by `followup` exactly like a
   reload-hibernated one. Same mechanism, on a timer instead of a shutdown.
3. **Auto-reap on spawn.** If every slot is taken, the **least recently active**
   `completed` child is closed to make room and the spawn result names it.
   "Least recently active" counts follow-ups, not just when the child finished,
   so an old agent you are still talking to is not the victim. Hibernated agents
   are never taken here — they hold no slot, so closing one would destroy a
   conversation without freeing anything. The reclaim happens only *after* every
   cheap validation passes, so a spawn with a typo can never cost an agent.

Never reclaimed: `running`/`starting` (work in flight), `stalled` (a network
problem, not a dead agent), `interrupted` (the human stopped it on purpose), and
`failed` — whose transcript is the only post-mortem there is. When all six slots
hold those, the spawn fails with a message naming what is in the way. Auto-reap
goes through the same `close()` as an explicit one, so the cleanup policy
(including keeping a failed child's session directory) is shared by construction.

### Stalls

When the connection drops, a child's provider call can hang or sit in retry
backoff: no events, no `agent_settled`, and the process never exits — so the
exit handler does not apply and the agent would show "running" forever while its
result never arrives.

Every child event stamps a `lastEventAt`. A busy child that has said nothing for
`stallSeconds` (default 120) is marked **`stalled`** (`⚠`): a distinct icon in
the strip, a `1 stalled` count in the footer, and exactly one toast — never a
kill, because from out here a partition and a slow model look identical.
`list` and `read` both say so and report how long it has been silent, so the
orchestrator cannot mistake a stalled child's last message for a finished
answer.

A child that starts producing events again returns to `running` by itself.

To recover: `subagent { action: "retry", name }`. It aborts the wedged turn and
re-prompts the child **on its existing session file**, so nothing it had already
done is lost. If the process will not even answer an abort, it is stopped and
revived the same way hibernation revives one, then re-prompted there.

Set `"stallSeconds": 0` to switch stall detection off.

## Tests

```bash
node extensions/subagents/tests/run.mjs        # everything
node extensions/subagents/tests/run.mjs extensions/subagents/tests/rpc.test.ts   # one file
```

The tests are plain `node:test`, loaded through jiti by `tests/run.mjs` — the
same loader pi uses for extensions. Node's native strip-only TypeScript support
cannot be used here: it rejects the parameter properties this code relies on
(`constructor(private options: ChildRpcOptions) {}`). The runner borrows the
installed pi package's `node_modules` (found via `pi` on `PATH`, or
`PI_PACKAGE_ROOT`) for `@earendil-works/*` and `typebox`.

Most suites are pure. Several drive real machinery on purpose: `revive.test.ts`,
`resume.test.ts` and parts of `rpc.test.ts` spawn actual child processes through
a `PI_SUBAGENT_BIN` stub — including one that spawns a grandchild, so the
process-group kill is asserted against the operating system rather than against a
spy, and one that exits immediately, so the crash-loop cap is counted against
real deaths. `delivery.test.ts` drives the **real extension** through the same
handler surface pi uses, with a real `SubagentManager` and mailbox behind it.
`focus.test.ts` instantiates pi's real `TuiAltScreen`. Mocking any of these would
test the mock rather than the platform behaviour that caused the bug — which has
happened here before: a bug survived a fully green suite because a test double
supplied the very method the real class was missing.

`tests/transitions.test.ts` is the regression guard for the "nobody was told"
class. It re-derives the `AgentStatus`, `TransitionCause`, `DeliveryTiming` and
`MailKind` unions from the **source text** and asserts the table covers each
exactly, that every row carries a reason, that only `report` is evictable (by
flooding a real `Mailbox` past its bounds, not by reading the flag), and that
every actionable kind has a rule in `orchestrator.md` that prescribes an action.
That last one is mechanical on purpose: a capability without a line in
`orchestrator.md` means the model has the tool and not the habit.

Two files are load-bearing for the liveness invariant above and deserve a note.
`tests/cancel.test.ts` and `tests/ask-liveness.test.ts` both test for the absence
of a hang, which is not something an ordinary `await` can assert: a regression
there does not fail, it stops. Every case therefore races a wall-clock bound and
fails loudly on expiry. Both use stub children rather than real models — a
transport that accepts commands and answers nothing, and a process that really
polls the answers directory — because the property under test is the shape of the
await, not any model behaviour.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Tool, command, widget wiring, mailbox delivery, orchestrator mode |
| `notify.ts` | The status in both forms — `statusBadges` for the bar, `formatStatus` as the footer sentence — from one set of counts; mail routing (wake / steer / at-settle / ride), the single mailbox drain |
| `transitions.ts` | **The transition table**: which status change publishes what, when it is delivered, and why each silence is deliberate |
| `resume.ts` | Whether interrupted work restarts itself: the unfinished/finished split, the age bound, the crash-loop cap |
| `switcher.ts` | The selectable chat strip: entries, selection, key classification |
| `editor.ts` | The main input box, wrapped so `↓` on an empty buffer reaches the strip, and so the top border carries the badge bar |
| `badge-bar.ts` | Laying published badges into the right-hand end of the editor's top border: finding the rule, sharing it with the scroll indicator, width and truncation |
| `../shared/border-badges.ts` | The cross-extension badge registry and the renderer-presence signal (not owned by this extension) |
| `chat-view.ts` | Full-screen chat overlay: header, viewport, input box, switcher, `keepFocus` |
| `chat-pane.ts` | One chat per child, built from pi's own message components |
| `session-log.ts` | Partial-write-tolerant reader for a child's `session.jsonl` |
| `manager.ts` | Child lifecycle, event handling, usage accounting, `onAgentEvent` |
| `identity.ts` | The uuid spine: the boot flag, session identity, header reading |
| `registry.ts` | The agent tree on disk, outside any session: atomic writes, pid liveness |
| `hibernate.ts` | Shutdown policy and the record a child survives a reload as |
| `reap.ts` | Which finished child to hibernate or reclaim, and when |
| `ask.ts` | The child→parent question channel: paths, answer files, parsing |
| `stall.ts` | Liveness: when silence from a busy child becomes a stall |
| `rpc.ts` | Minimal JSONL client for `pi --mode rpc` children; states the liveness invariant |
| `context.ts` | Session seeding: fork / compact / fresh, and the `auto` decision |
| `summary-cache.ts` | One parent-context summarization per conversation point |
| `progress.ts` | What a spawn says through `onUpdate` while it is happening |
| `render.ts` | `renderCall` / `renderResult` for the `subagent` tool |
| `personas.ts` | Persona discovery |
| `notes.ts` | Shared-notes read/append, used by both the parent and children |
| `mailbox.ts` | Bounded parent mailbox |
| `child-extension.ts` | Loaded *inside* children: `report_to_parent`, `shared_notes`, `ask_parent` |
| `orchestrator.md` | The orchestrator-mode system prompt text |

`rpc.ts` exists rather than using the exported `RpcClient` because that client
hardcodes `node`, defaults to a relative CLI path, and echoes child stderr into
the parent's stderr — which corrupts the TUI.

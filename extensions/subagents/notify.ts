/**
 * How a finished child reaches the human and the parent agent.
 *
 * A toast is not a notification: it disappears while you are looking elsewhere,
 * which is exactly when a subagent finishes. Two durable signals replace it:
 *
 *   - a **status line** that stays until the facts change, so "did anything
 *     finish?" is answerable at a glance. It is rendered two ways from one set of
 *     counts: {@link statusBadges} for the badge bar in the editor's top
 *     border, and {@link formatStatus} as a sentence for pi's footer, which is
 *     the fallback when nothing is drawing that bar. Sharing the counts is what
 *     stops the two ever disagreeing about whether something is blocked;
 *   - **waking the parent** when a result lands while it is idle, so the
 *     orchestrator reacts to its own children instead of sitting on a finished
 *     result until the human types something.
 *
 * The decisions live here as pure functions so they can be tested without a
 * terminal, an agent session or a child process.
 */

import type { BadgeTone, StatusBadge } from "../shared/border-badges.ts";
import { type MailEvent, type MailKind, type Mailbox, formatMail } from "./mailbox.ts";
import { type DeliveryTiming, deliveryFor, drainsWithoutUser } from "./transitions.ts";
import type { AgentStatus } from "./types.ts";

export type { DeliveryTiming };

/** What happens when a child produces a final result or an error. */
export type OnFinishMode =
	/** Deliver it and start a parent turn, when the parent is idle. */
	| "wake"
	/** Only update the footer and show a toast; the mail rides into the next request. */
	| "notify";

/**
 * Where a piece of mail goes right now.
 *
 * Three of these four are self-driving. Only `"ride"` waits for a human, and
 * only `report` is ever routed to it — see `routeMail`.
 */
export type MailRoute =
	/** Deliver it immediately and trigger a parent turn. The parent is idle. */
	| "wake"
	/**
	 * Steer it into the turn already running, so it lands between tool calls.
	 *
	 * For mail meaning something is *stopped*: a turn can run for minutes and a
	 * blocked child does not become less blocked while it does.
	 */
	| "steer"
	/**
	 * Deliver when the current turn settles.
	 *
	 * The default for everything actionable. A turn always ends, so this drains
	 * with no user input — which is what makes an intermediate parent in a nested
	 * tree work at all.
	 */
	| "at-settle"
	/** Leave it in the mailbox; `before_agent_start` folds it into the next request. */
	| "ride";

export interface AgentCounts {
	running: number;
	/** Busy but silent for too long — usually a dropped connection. */
	stalled: number;
	/** Blocked inside `ask_parent`; only the parent can unblock them. */
	waiting: number;
	done: number;
	failed: number;
	stopped: number;
	/** Survived a parent reload; no process until something is sent to them. */
	hibernated: number;
	idle: number;
	/** Everything except closed agents, which no longer exist. */
	total: number;
}

export function countAgents(statuses: readonly AgentStatus[]): AgentCounts {
	const counts: AgentCounts = {
		running: 0,
		stalled: 0,
		waiting: 0,
		done: 0,
		failed: 0,
		stopped: 0,
		hibernated: 0,
		idle: 0,
		total: 0,
	};
	for (const status of statuses) {
		if (status === "closed") continue;
		counts.total += 1;
		switch (status) {
			case "starting":
			case "running":
				counts.running += 1;
				break;
			case "stalled":
				counts.stalled += 1;
				break;
			case "waiting":
				counts.waiting += 1;
				break;
			case "completed":
				counts.done += 1;
				break;
			case "failed":
				counts.failed += 1;
				break;
			case "interrupted":
				counts.stopped += 1;
				break;
			case "hibernated":
				counts.hibernated += 1;
				break;
			default:
				counts.idle += 1;
				break;
		}
	}
	return counts;
}

/**
 * The glyph that stands in for the word "subagents".
 *
 * The badge carries no `label` chip, which every other publisher on the bar has.
 * That is the point: `subagents` is nine columns to say something a glyph says in
 * two, and the bar is shared. The robot *is* the label.
 *
 * Two columns, and that is measured rather than assumed — U+1F916 is East Asian
 * Wide, so `visibleWidth` reports 2 while `.length` reports 2 only by the
 * accident of it being a surrogate pair (`❓` is length 1 and width 2). Every
 * width decision on the bar goes through `visibleWidth` for exactly this reason;
 * see `badge-bar.ts`.
 */
export const AGENT_GLYPH = "🤖";

/**
 * Marker for unread mail, matching the one the switcher strip already uses.
 *
 * Same glyph in both places on purpose: the strip shows which agent has unread
 * mail, and this says how much there is in total.
 */
export const UNREAD_GLYPH = "●";

/**
 * The single tone that has to carry every state at once.
 *
 * The badge shows one number, so the *colour* is the only channel left for "and
 * how is that going?". Precedence is by what it asks of the reader, and the two
 * bad-news tones share a background (see `RECOMMENDED_TOKENS`) so the ordering
 * between them decides emphasis rather than visibility:
 *
 *   - `waiting` outranks everything, and outranks `failed` in particular. It is
 *     the only state where **you** are what is missing: `ask_parent` has no
 *     timeout, so a blocked child stays blocked for as long as it takes someone
 *     to answer. `warn` is the documented tone for "blocked, not broken, and the
 *     reader can clear it themselves", which is exactly this.
 *   - `stalled` and `failed` are `error`: something is broken and wants
 *     investigating. A stall is a dropped connection, a failure is a failure.
 *   - `running` is `ok`, unless *nothing* has actually started yet — a spawn can
 *     spend a whole summarization before its child exists (see `progress.ts`), and
 *     during that window `pending` says "wait" rather than "working".
 *   - `done` is `neutral`, not `muted`. The shared vocabulary draws that line as
 *     "information to read" against "information to be able to ignore", and a
 *     finished agent is the result you delegated for; it still needs a
 *     close-or-keep decision.
 *   - Everything left — idle, hibernated, stopped — is `muted` and recedes.
 */
function badgeTone(counts: AgentCounts, starting: number): BadgeTone {
	if (counts.waiting > 0) return "warn";
	if (counts.stalled > 0 || counts.failed > 0) return "error";
	// `countAgents` folds `starting` into `running`, so "all of them are still
	// starting" is the case where nothing is under way yet.
	if (counts.running > 0) return starting === counts.running ? "pending" : "ok";
	if (counts.done > 0) return "neutral";
	return "muted";
}

/**
 * The badge-bar form: `🤖 2`, plus `● 3` when mail is waiting.
 *
 * The same facts as {@link formatStatus} and the same "undefined means nothing to
 * say" contract; only the shape differs, exactly as in `extensions/mcp`. One chip
 * in the ordinary case, because the bar is shared and this extension is a guest
 * on it like everyone else — the count goes in the text and the state goes in the
 * tone rather than into more chips.
 *
 * Unread is the one thing that earns a second chip, and only while it is
 * non-zero. It is not a *state* of the agents, so folding it into the tone would
 * mean overwriting "one of these is blocked on you" with "you have mail", and
 * mail drains by itself while a blocked child does not.
 */
export function statusBadges(
	statuses: readonly AgentStatus[],
	unread: number,
): StatusBadge[] | undefined {
	const counts = countAgents(statuses);
	if (counts.total === 0) return undefined;
	const starting = statuses.filter((status) => status === "starting").length;
	const badges: StatusBadge[] = [
		{ text: `${AGENT_GLYPH} ${counts.total}`, tone: badgeTone(counts, starting) },
	];
	if (unread > 0) badges.push({ text: `${UNREAD_GLYPH} ${unread}`, tone: "neutral" });
	return badges;
}

/**
 * How many states the footer spells out before it starts counting heads.
 *
 * Two, because the footer is **one shared line**: every extension's status is
 * joined onto it, so a census of eight states pushes everybody else off the
 * screen. The full breakdown is a keystroke away in the switcher directly below
 * the editor, which is where a reader who cares about the tail is already
 * looking. The footer's job is the headline.
 */
const MAX_STATUS_PARTS = 2;

/**
 * The footer line, e.g. `subagents: 1 running, 2 done (1 unread)`.
 *
 * Returns `undefined` when there is nothing to say, which is also how the status
 * is cleared: an extension with no agents must occupy no footer space at all.
 *
 * States are listed most-actionable first and then truncated, so what survives
 * the {@link MAX_STATUS_PARTS} cap is always the part worth acting on. The
 * remainder becomes a single `+N more`, counted in *agents* rather than states
 * so the numbers on the line still add up to everything that exists.
 */
export function formatStatus(
	statuses: readonly AgentStatus[],
	unread: number,
): string | undefined {
	const counts = countAgents(statuses);
	if (counts.total === 0) return undefined;
	const ranked: Array<[number, string]> = [
		// First: the only state where something is blocked on *you*.
		[counts.waiting, "waiting for you"],
		// Then the two that mean work is (or should be) happening right now.
		[counts.running, "running"],
		[counts.stalled, "stalled"],
		// Then the news, in the order a reader would act on it.
		[counts.done, "done"],
		[counts.failed, "failed"],
		[counts.stopped, "stopped"],
		// Last: states that need nothing from anybody.
		[counts.hibernated, "hibernated"],
		[counts.idle, "idle"],
	];
	const present = ranked.filter(([count]) => count > 0);
	const shown = present.slice(0, MAX_STATUS_PARTS);
	const parts = shown.map(([count, label]) => `${count} ${label}`);
	const remainder = counts.total - shown.reduce((sum, [count]) => sum + count, 0);
	if (remainder > 0) parts.push(`+${remainder} more`);
	const suffix = unread > 0 ? ` (${unread} unread)` : "";
	return `subagents: ${parts.join(", ")}${suffix}`;
}

/**
 * Whether this kind of mail may start a parent turn when the parent is idle.
 *
 * A `switch` with a `never` default rather than a chain of `if`s: a `MailKind`
 * added without a wake decision here is a **compile error**, not a kind that
 * quietly falls through to "does not wake". The stall bug was exactly that shape
 * from the other direction — a wake rule for a kind nothing published — and the
 * cure for both is that the compiler counts the cases.
 *
 * This is only the *idle* question. What happens when the parent is **busy** is
 * `deliveryFor(kind)`, and that is the half that was broken: see `routeMail`.
 */
export function wakesParent(kind: MailKind, onFinish: OnFinishMode): boolean {
	switch (kind) {
		// A chatty child would otherwise start a parent turn every few seconds,
		// which is the opposite of "spawning does not block you". This is a statement
		// about `report` specifically — about volume — and not about whether a human
		// is present. Every other kind is bounded per agent by construction.
		case "report":
			return false;
		// Always wakes, whatever `onFinish` says: that setting is about whether
		// *finished* work starts a turn, and a blocked child is not finished work —
		// `ask_parent` has no timeout, so nobody else is coming to unblock it.
		case "question":
			return true;
		// The case the human actually hit: the notice otherwise reaches the
		// orchestrator only at `before_agent_start`, so it sits unread until the
		// human types — while they watch the warning in the UI and nothing happens.
		// A stalled child needs someone to read it and retry it; that someone is the
		// orchestrator, not the human.
		case "stall":
			return true;
		// Not urgent, but still self-driving: an idle parent has nothing better to
		// do, and under nesting there is no human whose next message could carry it.
		case "hibernated":
		case "restored":
		case "resumed":
			return true;
		// News, and the reason delegation happened. Deferred to the setting because
		// a human may prefer results to wait for their next message — but see
		// `routeMail`: `onFinish` is a preference of a *watching human*, and a parent
		// with no UI has none, so it does not apply there.
		case "final":
		case "error":
			return onFinish === "wake";
		default: {
			// Compile-time exhaustiveness: a new MailKind lands here as a type error
			// until somebody decides whether it wakes.
			const _exhaustive: never = kind;
			void _exhaustive;
			return false;
		}
	}
}

/**
 * Where a freshly published piece of mail goes.
 *
 * ## The bug this function used to have
 *
 * It read `wakesParent(kind) && idle ? "wake" : "ride"`. "Ride" meant *wait for
 * `before_agent_start`* — which fires only when a **user sends a message**. At
 * depth 1 that is merely a delay, because a human is sitting there. Under
 * nesting it is fatal: a grandchild's parent is itself a `pi --mode rpc` process
 * with no human attached, ever, so its queue was never drained at all. The tree
 * silently stopped working below depth 1, and nothing reported it.
 *
 * ## What it does now
 *
 * Delivery is self-driving. Three outcomes, taken from the kind's
 * {@link DeliveryTiming} rather than from whether somebody happens to be typing:
 *
 *   - **`steer`** — the parent is mid-turn and the mail says something is
 *     *stopped* (`question`, `stall`, an exhausted auto-resume). Steering lands
 *     between tool calls instead of after a turn that may run for minutes.
 *   - **`wake`** — the parent is idle: start a turn now.
 *   - **`at-settle`** — the parent is busy: deliver when this turn ends. A turn
 *     always ends, so this drains without anyone typing. **This is the default**
 *     for everything actionable.
 *   - **`ride`** — only `report`, the one deliberately passive kind.
 *
 * `hasUI` is not cosmetic here. `onFinish: "notify"` is a preference expressed
 * by a human who wants to read results in their own time; a headless parent has
 * no human to have that preference, and honouring it there would strand every
 * result in the queue forever. So it is ignored when there is no UI.
 */
export function routeMail(input: {
	kind: MailKind;
	idle: boolean;
	onFinish: OnFinishMode;
	/**
	 * Whether a human is watching this parent at all.
	 *
	 * `false` for every intermediate parent in a nested tree. Defaults to `true`
	 * so existing callers keep the depth-1 behaviour they were written against.
	 */
	hasUI?: boolean;
}): MailRoute {
	const hasUI = input.hasUI ?? true;
	const timing = deliveryFor(input.kind);
	// The one passive kind. Nothing self-driving about it, by design.
	if (timing === "next-request") return "ride";

	if (input.idle) {
		// A headless parent has no human whose `onFinish` preference could apply,
		// and no next message to ride along with. Idle means "deliver now".
		if (!hasUI) return "wake";
		return wakesParent(input.kind, input.onFinish) ? "wake" : "at-settle";
	}

	// Busy. Never "ride" for an actionable kind: that is the branch that meant
	// "never" for a parent nobody types into.
	return timing === "immediate-steer" ? "steer" : "at-settle";
}

/**
 * Whether this kind must be delivered without waiting for a user.
 *
 * The invariant the nesting fix rests on, exposed as one predicate so tests can
 * assert it over every kind at once rather than case by case.
 */
export function selfDriving(kind: MailKind): boolean {
	return drainsWithoutUser(kind);
}

/**
 * The one place mail leaves the mailbox.
 *
 * `drain()` is destructive, so both delivery paths — riding into the parent's
 * next request and waking an idle parent — have to come through here, or a
 * result is delivered twice or lost entirely.
 */
export function takeMail(mailbox: Mailbox): { events: MailEvent[]; content: string } | undefined {
	const events = mailbox.drain();
	if (events.length === 0) return undefined;
	return { events, content: formatMail(events) };
}

/**
 * Undo a `takeMail()` whose delivery failed.
 *
 * Re-published rather than spliced back in: the mailbox owns sequencing and
 * bounding, and this is the newest news anyway.
 */
export function returnMail(mailbox: Mailbox, events: readonly MailEvent[]): void {
	for (const event of events) {
		mailbox.publish({
			kind: event.kind,
			agentId: event.agentId,
			agentName: event.agentName,
			content: event.content,
			omittedBefore: event.omittedBefore,
			// Without this a re-queued question loses the id that makes it
			// answerable, and the child it belongs to blocks forever.
			questionId: event.questionId,
		});
	}
}

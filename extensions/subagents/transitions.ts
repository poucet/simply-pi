/**
 * The single source of truth for "does this state change reach the orchestrator,
 * and when?".
 *
 * ## Why this file exists
 *
 * A child stalled. The manager noticed, set `status = "stalled"`, and told the
 * *human* through `onStall`. Nothing told the orchestrator. The human watched a
 * warning appear, waited, and eventually relayed it by hand.
 *
 * The first attempt at a fix added `if (kind === "stall") return true;` to
 * `wakesParent`. That was dead code: `"stall"` was not a `MailKind` and nothing
 * published one. Three separate things were missing — the kind, the publish, and
 * a rule in `orchestrator.md` telling the model to act on it — and enumerating
 * kinds harder in one of those three places found none of the others.
 *
 * So the rule is not "remember to publish". The rule is that **every** status
 * change goes through {@link mailForTransition}, and the table it consults is a
 * `Record<AgentStatus, …>`: adding a status to `AgentStatus` without deciding
 * its mail does not compile. Deliberate silence is an *entry* carrying a reason,
 * never an absence — an absence is indistinguishable from the bug above.
 *
 * ## Three columns, not one
 *
 * Each row answers three independent questions, and conflating any two of them
 * has already caused a bug:
 *
 *   1. **publish** — which `MailKind`, or `"silent"` with a reason.
 *   2. **persist** — whether the registry is rewritten. Not the same question:
 *      `stopAll` deliberately checkpoints the tree *before* marking everything
 *      closed, so that `kill pi && pi` finds the conversations. Persisting the
 *      `closed` would erase exactly the thing the checkpoint was for.
 *   3. **deliver** — *when* the mail reaches the orchestrator. See below; this is
 *      the column that makes nesting work at all.
 *
 * Evictability is the fourth axis and lives in `mailbox.ts` (`EVICTABLE`),
 * because it is a property of the kind rather than of the transition: two
 * transitions publishing `report` must not disagree about whether it can be
 * dropped.
 *
 * ## Delivery timing, and why it is not "does the parent happen to be idle"
 *
 * Publishing has always been unconditional. *Delivery* was not: mail that did
 * not wake an idle parent "rode into the next request" — and the next request
 * only exists when a **human types**. That is survivable at depth 1, where a
 * human is sitting there. It is fatal under nesting: a grandchild's parent is
 * itself a `pi --mode rpc` child with no human attached, ever. Its queue would
 * never drain at all. The tree silently stops working below depth 1.
 *
 * So `"next-request"` is not a delivery timing any actionable kind may use. The
 * default is {@link DeliveryTiming `"at-turn-end"`}: when the parent's turn
 * settles, the queue drains, whoever is (or is not) watching. `report` is the
 * one kind that stays passive, and only because a chatty child would otherwise
 * start a parent turn every few seconds and destroy the property that spawning
 * does not block you.
 *
 * ## What is deliberately silent
 *
 *   - **`interrupted`** — the parent asked for the stop. Publishing here was the
 *     S4 bug: a deliberate interrupt surfaced as `error — This operation was
 *     aborted`, i.e. a spurious failure for work the parent itself cancelled.
 *   - **`hibernated` by shutdown** — the orchestrator (or the human quitting)
 *     caused it, and every child hibernates at once. Reporting a state change
 *     the reader just requested is noise.
 *   - **`closed`** — same: `close` is an action the orchestrator takes, and its
 *     result is the tool call's return value.
 *   - **`starting`/`running`/`idle`** — progress, not news. `spawn` already
 *     returns synchronously and the footer tracks the rest.
 */

import type { MailKind } from "./mailbox.ts";
import type { AgentStatus } from "./types.ts";

/**
 * Why an agent arrived at a status.
 *
 * A status alone is not enough to decide mail: `hibernated` is silent when the
 * orchestrator triggered it and newsworthy when the idle sweep did, and that
 * distinction is the whole point of the cause column. Causes are named after
 * the event that produced them, not the code path, so a reader of the table can
 * check it against what actually happened without reading `manager.ts`.
 */
export type TransitionCause =
	/** A brand new child is being launched. */
	| "spawn"
	/** A child was given more work (`followup`/`steer`/`retry`). */
	| "resumed"
	/** A stalled child started producing events again by itself. */
	| "recovered"
	/** A blocked child got its answer and went back to work. */
	| "answered"
	/** A child asked the parent a question and stopped. */
	| "asked"
	/** The child finished its turn. */
	| "settled"
	/** The child reported an error inside a turn that has not ended yet. */
	| "child-error"
	/** The child process died on its own (crash, OOM, external kill). */
	| "died"
	/** The parent asked this child to stop. */
	| "abort-requested"
	/** A busy child has produced no events for longer than `stallSeconds`. */
	| "silent"
	/** A later sweep saw the same stall again; the first one already reported it. */
	| "still-silent"
	/** The idle sweep stopped a completed child's process after `idleHibernateMinutes`. */
	| "idle-sweep"
	/** A reload or a quit stopped every child at once. */
	| "shutdown"
	/** A relaunch on the existing session file succeeded. */
	| "revived"
	/**
	 * The framework restarted interrupted work by itself.
	 *
	 * Distinct from `revived`, which is somebody asking for a process back. This
	 * one nobody asked for: a reload or a crash stopped a child mid-task and the
	 * framework picked it up again without a human or an orchestrator deciding to.
	 */
	| "auto-resumed"
	/** Auto-resume gave up: this child has stopped unfinished too many times. */
	| "resume-exhausted"
	/** A relaunch failed; the conversation is still on disk. */
	| "revive-failed"
	/** A parent reload brought records back from its own session entries. */
	| "reload-restore"
	/** A cold start adopted children from the registry. */
	| "cold-restore"
	/** The orchestrator (or the human) ended this agent. */
	| "closed";

/**
 * When mail reaches the orchestrator.
 *
 * Ordered most to least urgent. Note that none of these depend on a human: the
 * whole point of the column is that an intermediate parent in a nested tree —
 * a headless `pi --mode rpc` process nobody will ever type into — drains its
 * queue on its own.
 */
export type DeliveryTiming =
	/**
	 * Steered into the turn already in flight, arriving between tool calls.
	 *
	 * For mail that means something is **stopped**. A blocked or stalled child is
	 * not working, and waiting out a parent turn that may run for minutes is pure
	 * dead time — for a `question` it is dead time on both sides at once, since
	 * `ask_parent` has no timeout. When the parent is idle this degrades to
	 * starting a turn, which is the same urgency by a different mechanism.
	 */
	| "immediate-steer"
	/**
	 * Delivered when the parent's current turn settles; immediately if it is idle.
	 *
	 * **The default for everything actionable.** A turn always ends, so this
	 * drains without a human. It is the difference between "the orchestrator
	 * finds out a bit later" and "the orchestrator never finds out", which is
	 * what `"next-request"` meant for a nested parent.
	 */
	| "at-turn-end"
	/**
	 * Rides along with whatever the parent is next given. Never self-driving.
	 *
	 * Reserved for `report`: interim chatter is context for a decision the
	 * orchestrator will make anyway, not a decision of its own. Anything that
	 * *needs* acting on must not use this — under nesting it means "never".
	 */
	| "next-request";

/** One row of the table. */
export type MailDecision =
	| {
			publish: MailKind;
			/** When it reaches the orchestrator. Never `"next-request"` for actionable mail. */
			deliver: DeliveryTiming;
			/** Whether this transition rewrites the agent's registry node. */
			persist: boolean;
			/** Why it is delivered when it is. Shown by `/agents mail` and asserted in tests. */
			why: string;
	  }
	| {
			publish: "silent";
			persist: boolean;
			/** Why nothing is mailed. Never omit this: an absence is how the bug happened. */
			why: string;
	  };

/** A status whose mail depends on how it was reached. */
type CausedDecisions = {
	/** Used for any cause without its own row. */
	default: MailDecision;
	byCause: Partial<Record<TransitionCause, MailDecision>>;
};

type StatusPolicy = MailDecision | CausedDecisions;

function isCaused(policy: StatusPolicy): policy is CausedDecisions {
	return (policy as CausedDecisions).byCause !== undefined;
}

/**
 * The table. **Every** `AgentStatus` must appear; the `Record` type makes that a
 * compile error rather than a code review, and `tests/transitions.test.ts`
 * re-checks it at runtime against the union declared in `types.ts`, because this
 * project has no type-checker in its test loop.
 */
export const TRANSITION_TABLE: Record<AgentStatus, StatusPolicy> = {
	starting: {
		publish: "silent",
		persist: false,
		why: "Spawning is synchronous for the caller: the spawn tool's own result says the child started. Not persisted either — the agent has no session file on disk yet.",
	},
	running: {
		default: {
			publish: "silent",
			persist: true,
			why: "Progress, not news. The footer and the switcher track it; a turn per event would be unusable.",
		},
		byCause: {
			"auto-resumed": {
				publish: "resumed",
				// Not steered: nothing is blocked and nothing needs a decision. But it
				// must still arrive without a human, because the parent of a resumed
				// grandchild is itself headless — which is the whole reason
				// `"next-request"` is not available to actionable kinds.
				deliver: "at-turn-end",
				persist: true,
				why: "An agent came back to life on its own after a reload or a crash and is working again. The orchestrator did not ask for this and would otherwise see a child it believed was gone start editing files — or, worse, delegate the same task twice. Nothing is blocked on it, so it does not interrupt a turn.",
			},
			recovered: {
				publish: "silent",
				persist: true,
				why: "A stall that cleared itself needs no action. The stall mail already told the orchestrator to look; finding it working again is a non-event.",
			},
			answered: {
				publish: "silent",
				persist: true,
				why: "The orchestrator just answered; telling it the child resumed is echoing its own action back.",
			},
		},
	},
	idle: {
		default: {
			publish: "silent",
			persist: true,
			why: "A revived child with no work yet. The action that revived it is what reports, and it has produced nothing to read.",
		},
		byCause: {},
	},
	waiting: {
		default: {
			publish: "question",
			// Steered rather than queued: the child is doing nothing at all until this
			// is answered, so every second of the parent's current turn is dead time on
			// both sides. `ask_parent` has no timeout, so nobody else is coming.
			deliver: "immediate-steer",
			persist: true,
			why: "The child is STOPPED and only the orchestrator can restart it. Steering arrives between tool calls instead of after a turn that may run for minutes; when the parent is idle this starts a turn instead, which is the same urgency by another route.",
		},
		byCause: {},
	},
	stalled: {
		default: {
			publish: "stall",
			// Same reasoning as `question`: a stalled child does not become less
			// stalled while the parent works.
			deliver: "immediate-steer",
			persist: true,
			why: "This is the failure that motivated the table. A stalled child is STOPPED and needs someone to read it and retry it; that someone is the orchestrator, and it only reads mail when something delivers it.",
		},
		byCause: {
			"still-silent": {
				publish: "silent",
				persist: false,
				why: "The sweep runs on a timer, so the same stall is seen again every tick. It was mailed once, with an instruction; repeating it every tick would bury the mailbox in a kind that cannot be evicted, and steer the parent every tick on top.",
			},
		},
	},
	completed: {
		default: {
			publish: "final",
			// Not steered: the work is done and nothing is blocked, so interrupting a
			// turn mid-tool-call buys nothing. But it must not wait for a human either
			// — under nesting there is none — so the turn's end delivers it.
			deliver: "at-turn-end",
			persist: true,
			why: "The result is the point of delegating, and every result needs a decision (verify, then close or keep). Delivered when the current turn settles so a nested parent with no human still drains it.",
		},
		byCause: {},
	},
	failed: {
		default: {
			publish: "error",
			deliver: "at-turn-end",
			persist: true,
			why: "A failure needs the same decision a result does — retry, close, or re-delegate — and is at least as urgent. Same timing for the same reason.",
		},
		byCause: {
			"child-error": {
				publish: "silent",
				persist: false,
				why: "The child reported an error inside a turn that has not ended. Its `agent_settled` follows immediately and carries the same message as `error` mail; publishing here would mail the failure twice.",
			},
			"abort-requested": {
				publish: "silent",
				persist: true,
				why: "S4: the parent asked for this stop. A requested abort surfaced as `error — This operation was aborted`, i.e. a spurious failure for work the parent itself cancelled.",
			},
			"revive-failed": {
				publish: "silent",
				persist: true,
				why: "`revive` throws, and every path into it (`followup`, `retry`, `revive`) is a tool call the orchestrator is already awaiting. The error reaches it as that call's failure; mailing it as well says it twice.",
			},
			shutdown: {
				publish: "silent",
				persist: true,
				why: "Hibernation keeps a failed child failed rather than moving it. The failure was mailed when it happened; a reload is not a second one.",
			},
			"idle-sweep": {
				publish: "silent",
				persist: true,
				why: "Same: the sweep never picks a failed child, and if it somehow did, its failure was already reported.",
			},
			"reload-restore": {
				publish: "silent",
				persist: true,
				why: "A restore replays a failure the orchestrator already read in this same conversation.",
			},
			"cold-restore": {
				publish: "restored",
				deliver: "at-turn-end",
				persist: true,
				why: "A failed child from a previous run is still news to a parent with no memory of it — it holds a transcript worth reading and a session directory worth closing — but nothing is blocked on it, so it does not interrupt a turn.",
			},
			"resume-exhausted": {
				// `stall`, not `error`, and the choice is load-bearing rather than
				// cosmetic. Delivery timing is a property of the *kind* — `notify.ts`
				// routes an already-published event that no longer knows its cause — so
				// a row cannot be more urgent than the kind it publishes. This one has
				// exactly the shape `stall` describes: work that is STOPPED and will not
				// restart itself, needing somebody to read it and decide. `error` means
				// "the child failed and here is its result", which is a thing to file
				// rather than a thing to act on, and it waits for the turn to end.
				publish: "stall",
				deliver: "immediate-steer",
				persist: true,
				why: "Auto-resume has given up after repeated crashes. Silence here would be the exact failure this table exists to prevent, one level up: the framework quietly stops recovering and the work is stranded with nobody told. Published as `stall` because that is what it is — stopped work needing a decision — and because a row may not out-rank the kind it publishes.",
			},
		},
	},
	interrupted: {
		default: {
			publish: "silent",
			persist: true,
			why: "S4: a requested interrupt is not a fault. The parent asked for the stop and the tool call already returned; mailing it reports the parent's own action back as a failure.",
		},
		byCause: {},
	},
	hibernated: {
		default: {
			publish: "silent",
			persist: true,
			why: "Hibernation the orchestrator triggered (reload, quit, an explicit stop) needs no announcement: it asked, and every child moves at once.",
		},
		byCause: {
			"idle-sweep": {
				publish: "hibernated",
				// Deliberately not steered: nothing is lost and nothing is blocked, so
				// interrupting a turn to say "your finished child is asleep" would be the
				// kind of interruption `report` is bounded to avoid.
				deliver: "at-turn-end",
				persist: true,
				why: "The orchestrator explicitly decided to KEEP this agent and the system put it to sleep anyway. It must know its plan changed — but a followup revives it losing nothing, so it can hear at the end of the turn rather than inside one.",
			},
			"reload-restore": {
				publish: "silent",
				persist: true,
				why: "A reload is a continuation of the same conversation: the agents were already in the transcript and the orchestrator has not forgotten them.",
			},
			"cold-restore": {
				publish: "restored",
				// At the end of the turn, not steered: at cold start there is usually no
				// turn at all, so this becomes an immediate delivery anyway — and if a
				// turn *is* running, duplicate-spawn risk is not worth a mid-tool-call
				// interruption.
				deliver: "at-turn-end",
				persist: true,
				why: "Children the orchestrator has no memory of have just reappeared. Without this it spawns duplicates of work already in flight.",
			},
			"revive-failed": {
				publish: "silent",
				persist: true,
				why: "`revive` throws to its caller, which is a tool call the orchestrator is already awaiting. Mailing it as well says it twice.",
			},
		},
	},
	closed: {
		default: {
			publish: "silent",
			persist: true,
			why: "The orchestrator's own action; the `close` tool call returns the outcome. Its mailbox is drained in the same breath, so mailing here would deliver into a queue that is about to be emptied.",
		},
		byCause: {
			shutdown: {
				publish: "silent",
				// The load-bearing `persist: false` in this table.
				persist: false,
				why: "`stopAll` checkpoints the whole tree *before* marking anything closed, precisely so `kill pi && pi` finds the conversations and can offer them back. Persisting the `closed` would erase what the checkpoint was for, and a cold start would report nothing restorable.",
			},
		},
	},
};

/**
 * The decision for one transition. This is the only way to answer the question.
 *
 * Total by construction: the table covers every `AgentStatus`, and an unknown
 * cause falls back to that status's `default` row.
 */
export function mailForTransition(status: AgentStatus, cause: TransitionCause): MailDecision {
	const policy = TRANSITION_TABLE[status];
	if (!isCaused(policy)) return policy;
	return policy.byCause[cause] ?? policy.default;
}

/**
 * Rows whose `deliver` disagrees with their kind's timing. Must always be empty.
 *
 * Delivery timing is ultimately a property of the **kind**, because `notify.ts`
 * routes an already-published `MailEvent` that no longer remembers which
 * transition produced it. A row claiming to be more urgent than its kind would
 * therefore be a lie — the urgency would be silently dropped at the moment of
 * delivery, which is precisely the class of bug this file exists to prevent.
 *
 * So a row that wants to be steered must publish a kind that is steered. That is
 * why an exhausted auto-resume publishes `stall` rather than `error`.
 */
export function timingDisagreements(): string[] {
	const bad: string[] = [];
	for (const { status, cause, decision } of transitionRows()) {
		if (decision.publish === "silent") continue;
		if (decision.deliver !== DELIVERY_BY_KIND[decision.publish]) {
			bad.push(
				`${status}/${cause}: row says ${decision.deliver}, kind ${decision.publish} says ${DELIVERY_BY_KIND[decision.publish]}`,
			);
		}
	}
	return bad;
}

/**
 * When a kind of mail should reach the orchestrator, independent of transition.
 *
 * The table above answers this per transition, which is the right granularity
 * for deciding *whether* to publish. But `notify.ts` routes an already-published
 * `MailEvent`, which no longer knows its cause — so the timing has to be
 * derivable from the kind alone as well, and the two must agree. The test suite
 * asserts exactly that: every row's `deliver` matches `deliveryFor(row.publish)`.
 *
 * Exhaustive over `MailKind` via the `Record` type: a new kind does not compile
 * until somebody chooses when it arrives.
 */
export const DELIVERY_BY_KIND: Record<MailKind, DeliveryTiming> = {
	// The one passive kind, and the reason the column exists as a spectrum rather
	// than a boolean. A chatty child publishing every few seconds would otherwise
	// start (or interrupt) a parent turn every few seconds, which destroys the
	// property that spawning does not block you. Interim chatter is context for a
	// decision the orchestrator will make anyway, not a decision of its own.
	report: "next-request",
	final: "at-turn-end",
	error: "at-turn-end",
	// Something is stopped and only the orchestrator can restart it.
	question: "immediate-steer",
	stall: "immediate-steer",
	hibernated: "at-turn-end",
	restored: "at-turn-end",
	// An agent restarting itself is news but not an emergency.
	resumed: "at-turn-end",
};

/** When mail of this kind should reach the orchestrator. */
export function deliveryFor(kind: MailKind): DeliveryTiming {
	return DELIVERY_BY_KIND[kind];
}

/**
 * Whether this kind is self-driving — i.e. delivered without a human.
 *
 * Everything except `report`. Written as a derivation from the timing rather
 * than as a second list, so the two cannot drift.
 */
export function drainsWithoutUser(kind: MailKind): boolean {
	return deliveryFor(kind) !== "next-request";
}

/**
 * Runtime companion to the compile-time exhaustiveness of the table.
 *
 * The `Record<AgentStatus, …>` type catches a *missing* status. This catches the
 * other half: a status added to the union, added to the table, and then never
 * listed here — so tests can iterate the real set rather than a stale copy.
 * The `never` assertion below is what makes the two stay in step.
 */
export const ALL_STATUSES = [
	"starting",
	"running",
	"stalled",
	"waiting",
	"idle",
	"completed",
	"failed",
	"interrupted",
	"hibernated",
	"closed",
] as const satisfies readonly AgentStatus[];

/**
 * Compile-time proof that `ALL_STATUSES` misses nothing.
 *
 * If a member is added to `AgentStatus` and not to the array above, the
 * `Exclude` below stops being `never` and this line fails to type-check. It is a
 * type-only construct: it costs nothing at runtime.
 *
 * This project has no `tsconfig.json` and no typescript dependency, so nothing
 * in the test loop actually runs a type-checker — which is why
 * `tests/transitions.test.ts` re-derives both unions from the source text and
 * asserts the same property at runtime. Belt and braces, deliberately: the belt
 * is free and the braces are the ones that hold.
 */
export type MissingStatus = Exclude<AgentStatus, (typeof ALL_STATUSES)[number]>;
const _everyStatusIsListed: MissingStatus extends never ? true : false = true;
void _everyStatusIsListed;

/** Every cause, for the same reason `ALL_STATUSES` exists. */
export const ALL_CAUSES = [
	"spawn",
	"resumed",
	"recovered",
	"answered",
	"asked",
	"settled",
	"child-error",
	"died",
	"abort-requested",
	"silent",
	"still-silent",
	"idle-sweep",
	"shutdown",
	"revived",
	"auto-resumed",
	"resume-exhausted",
	"revive-failed",
	"reload-restore",
	"cold-restore",
	"closed",
] as const satisfies readonly TransitionCause[];

export type MissingCause = Exclude<TransitionCause, (typeof ALL_CAUSES)[number]>;
const _everyCauseIsListed: MissingCause extends never ? true : false = true;
void _everyCauseIsListed;

/** Every delivery timing, for the same reason. */
export const ALL_TIMINGS = [
	"immediate-steer",
	"at-turn-end",
	"next-request",
] as const satisfies readonly DeliveryTiming[];

export type MissingTiming = Exclude<DeliveryTiming, (typeof ALL_TIMINGS)[number]>;
const _everyTimingIsListed: MissingTiming extends never ? true : false = true;
void _everyTimingIsListed;

/** Flattened view of the table: one entry per decision actually reachable. */
export function transitionRows(): Array<{
	status: AgentStatus;
	cause: TransitionCause | "*";
	decision: MailDecision;
}> {
	const rows: Array<{ status: AgentStatus; cause: TransitionCause | "*"; decision: MailDecision }> =
		[];
	for (const status of ALL_STATUSES) {
		const policy = TRANSITION_TABLE[status];
		if (!isCaused(policy)) {
			rows.push({ status, cause: "*", decision: policy });
			continue;
		}
		rows.push({ status, cause: "*", decision: policy.default });
		for (const [cause, decision] of Object.entries(policy.byCause)) {
			rows.push({ status, cause: cause as TransitionCause, decision: decision as MailDecision });
		}
	}
	return rows;
}

/**
 * Human-readable rendering of the whole table.
 *
 * Used by the tests (so a reviewer sees the decisions as a table rather than as
 * assertions) and by `/agents mail`, so the rules can be checked against
 * behaviour without reading this file.
 */
export function describeTransitionTable(): string {
	const header = `${"status".padEnd(12)} ${"cause".padEnd(16)} ${"mail".padEnd(11)} ${"delivery".padEnd(16)} why`;
	const rows: string[] = [
		header,
		"-".repeat(header.length),
		...transitionRows().map(({ status, cause, decision }) => {
			const timing = decision.publish === "silent" ? "—" : decision.deliver;
			return `${status.padEnd(12)} ${cause.padEnd(16)} ${decision.publish.padEnd(11)} ${timing.padEnd(16)} ${decision.why}`;
		}),
		"",
		"Delivery timings, none of which require a human to type:",
		"  immediate-steer  steered into the running turn, between tool calls",
		"  at-turn-end      delivered when the current turn settles (or now, if idle)",
		"  next-request     rides along with whatever the parent is next given",
	];
	return rows.join("\n");
}

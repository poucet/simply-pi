/**
 * Bringing back work that nobody chose to stop.
 *
 * ## The problem
 *
 * "Hibernated" covers two states that want opposite treatment:
 *
 *   - a child that **finished**, whose process the idle sweep reclaimed. Waking
 *     it would redo work that is already done.
 *   - a child that was **still working** when a reload, a crash or a `kill -9`
 *     took its process away. Nobody decided to stop it. Left alone it is work
 *     stranded on disk indefinitely — and that is not hypothetical: it happened
 *     to a real agent in this project.
 *
 * The old behaviour treated both as the second case's worst outcome. A reload
 * restored records but started no process, and a cold start deliberately went
 * further and refused to auto-spawn anything, surfacing "ask the human to run
 * `/agents restore`". That caution is right for a finished child and wrong for
 * an unfinished one.
 *
 * ## Why this is framework behaviour and not a line in orchestrator.md
 *
 * Everywhere else in this extension the fix for "the orchestrator does not do X"
 * has been to add a rule telling it to do X. That works when X is a judgement.
 * Resuming interrupted work is not a judgement — there is exactly one right
 * answer and the model has demonstrably not been taking it. Guidance to a model
 * is advice it may decline; this must simply happen.
 *
 * ## The two edges
 *
 * **Age.** A reload or a session switch resumes regardless of age: the process
 * was alive moments ago and the conversation is still the one in front of you.
 * A cold start (`kill pi && pi`) cannot know how long ago that was, so it only
 * resumes work younger than `autoResumeMaxAgeMinutes` (default 60). Anything
 * older is surfaced for `/agents restore` exactly as before — a day-old child
 * springing to life and editing files is a worse surprise than a missing one.
 *
 * **Crash loops.** A child that dies unfinished, resumes, and dies again would
 * otherwise retry forever, burning tokens and rewriting the same broken thing.
 * Attempts are counted **on the registry node**, so the count survives the very
 * restart it is counting; past `maxResumeAttempts` (default 3) the agent is
 * marked failed with a reason naming the count, published through the ordinary
 * transition table. Failing loudly is the point: a silent give-up is the bug
 * this whole file exists to fix, one level up.
 */

/** How recently a cold start still considers unfinished work worth resuming. */
export const DEFAULT_AUTO_RESUME_MAX_AGE_MINUTES = 60;

/** How many times an agent may be auto-resumed before it is declared broken. */
export const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

/**
 * The statuses that mean "was still working when the process went away".
 *
 * `waiting` is deliberately **not** here: a child blocked in `ask_parent` stopped
 * because the parent had not answered, and resuming it would restart a turn that
 * is going to block again immediately. Its question is re-announced by the child
 * itself on revive (see `child-extension.ts`), which is the correct recovery.
 */
export const UNFINISHED_STATUSES = ["running", "starting", "stalled"] as const;

export type UnfinishedStatus = (typeof UNFINISHED_STATUSES)[number];

/** Whether this status means the child still had work in flight. */
export function isUnfinished(status: string | undefined): boolean {
	return (UNFINISHED_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * The little that a resume decision needs to know.
 *
 * Structural rather than `ManagedAgent` or `RegistryNode` so the rules can be
 * argued with in tests using plain objects, and so the same function serves both
 * the reload path (which has agents) and the cold path (which has nodes).
 */
export interface ResumeCandidate {
	/** Identity, for messages. */
	name: string;
	/** The status recorded *before* the process went away. */
	status: string;
	/** When this node last did anything, in epoch ms. */
	lastActiveAt: number;
	/** How many times it has already been auto-resumed. */
	resumeAttempts?: number;
	/** Whether the conversation is actually on disk; nothing else is resumable. */
	hasSessionFile: boolean;
}

/** How the parent came back, which is what decides whether age matters. */
export type ResumeTrigger =
	/** Same session, same machine, moments ago. Age is irrelevant. */
	| "reload"
	/** A new `pi` process that found the tree in the registry. Age is bounded. */
	| "cold-start";

export interface ResumePolicy {
	trigger: ResumeTrigger;
	now: number;
	/** `0` disables the age bound entirely. */
	autoResumeMaxAgeMinutes: number;
	maxResumeAttempts: number;
}

/** What should happen to one candidate. */
export type ResumeVerdict =
	/** Revive it and re-prompt it to continue. */
	| { action: "resume"; attempt: number }
	/**
	 * It has been resumed too many times: stop trying and say so.
	 *
	 * Carries the reason verbatim so the caller does not reinvent the wording and
	 * the tests can assert on one string.
	 */
	| { action: "give-up"; reason: string }
	/** Leave it asleep. `why` is for the log, not for the orchestrator. */
	| { action: "leave"; why: string };

/**
 * Whether to bring one paused agent back.
 *
 * Total: every candidate gets a verdict, and every verdict carries a reason.
 * Same discipline as the transition table — an absence of a decision is how
 * things get silently dropped.
 */
export function resumeVerdict(candidate: ResumeCandidate, policy: ResumePolicy): ResumeVerdict {
	if (!candidate.hasSessionFile) {
		return { action: "leave", why: "its session file is gone, so there is nothing to resume" };
	}
	if (!isUnfinished(candidate.status)) {
		// The important half of this function. A completed child is finished work;
		// restarting it would redo it, and the idle sweep put it to sleep on purpose.
		return {
			action: "leave",
			why: `it is ${candidate.status}, not interrupted work — nobody needs it restarted`,
		};
	}
	const attempts = candidate.resumeAttempts ?? 0;
	if (policy.maxResumeAttempts > 0 && attempts >= policy.maxResumeAttempts) {
		return {
			action: "give-up",
			reason:
				`"${candidate.name}" has been resumed automatically ${attempts} time(s) and stopped ` +
				"unfinished every time, so it is being left failed rather than restarted again. " +
				"Something about this task is crashing its process: read its transcript before " +
				"retrying it by hand.",
		};
	}
	// A reload knows the process was alive moments ago, so age tells it nothing.
	// A cold start cannot know that, and resuming day-old work unprompted is a
	// worse surprise than leaving it for `/agents restore`.
	if (policy.trigger === "cold-start" && policy.autoResumeMaxAgeMinutes > 0) {
		const ageMs = policy.now - candidate.lastActiveAt;
		if (ageMs > policy.autoResumeMaxAgeMinutes * 60_000) {
			return {
				action: "leave",
				why:
					`it last did anything ${Math.round(ageMs / 60_000)} minutes ago, beyond the ` +
					`${policy.autoResumeMaxAgeMinutes}-minute auto-resume window — /agents restore still offers it`,
			};
		}
	}
	return { action: "resume", attempt: attempts + 1 };
}

/** Partition a set of candidates into what to do with each. */
export function planResumes<T extends ResumeCandidate>(
	candidates: readonly T[],
	policy: ResumePolicy,
): {
	resume: Array<{ candidate: T; attempt: number }>;
	giveUp: Array<{ candidate: T; reason: string }>;
	leave: Array<{ candidate: T; why: string }>;
} {
	const resume: Array<{ candidate: T; attempt: number }> = [];
	const giveUp: Array<{ candidate: T; reason: string }> = [];
	const leave: Array<{ candidate: T; why: string }> = [];
	for (const candidate of candidates) {
		const verdict = resumeVerdict(candidate, policy);
		if (verdict.action === "resume") resume.push({ candidate, attempt: verdict.attempt });
		else if (verdict.action === "give-up") giveUp.push({ candidate, reason: verdict.reason });
		else leave.push({ candidate, why: verdict.why });
	}
	return { resume, giveUp, leave };
}

/**
 * What to say to a child that is being picked back up.
 *
 * Deliberately does not restate the task: the child's own conversation is intact
 * and re-describing the job invites it to start over rather than continue. It is
 * told what happened to it, because from inside the session the gap is invisible
 * — the last thing it remembers is its own half-finished turn.
 */
export function resumePrompt(name: string, trigger: ResumeTrigger): string {
	const how =
		trigger === "reload"
			? "Your process was stopped by a reload of the parent session"
			: "Your process was stopped when the parent pi exited";
	return (
		`${how}, mid-task, and has just been restarted automatically. Nobody cancelled ` +
		"your work.\n\n" +
		"Re-check the current state of the files before assuming anything: an edit you " +
		"believe you made may not have been written, and a command you started may not " +
		"have finished. Then continue where you left off and finish the task you were " +
		"given. If it turns out the work was already complete, say so and stop rather " +
		"than redoing it."
	);
}

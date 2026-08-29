/**
 * Liveness for children that are still alive but no longer working.
 *
 * The exit handler in `manager.ts` covers children that *die*. It does not
 * cover the common failure on a laptop: the network drops, the child's provider
 * call hangs or sits in retry backoff, and the process stays up producing
 * nothing. No `agent_settled` ever arrives, so the agent shows "running"
 * forever and its result never arrives.
 *
 * The only observable that distinguishes that from ordinary slow work is time
 * since the last event, so that is what is tracked. A stall is a *report*, never
 * a kill: a long tool call or a slow model is indistinguishable from a partition
 * from out here, and killing on suspicion would be worse than the disease.
 *
 * Pure so it can be tested without waiting two minutes for anything.
 */

/** Seconds of silence from a busy child before it is called stalled. */
export const DEFAULT_STALL_SECONDS = 120;

export interface StallInput {
	/** Between prompt() and the matching agent_settled. */
	busy: boolean;
	status: string;
	/** Timestamp of the last event received from the child, if any. */
	lastEventAt?: number;
	now: number;
	stallSeconds: number;
	/**
	 * Whether the child is blocked inside `ask_parent`.
	 *
	 * Such a child is silent *on purpose* and for as long as it takes — there is
	 * no timeout on a question. Reporting it as stalled would blame the network
	 * for the parent's own unanswered question, and would send the human off to
	 * check their wifi when what is needed is an answer.
	 */
	awaitingAnswer?: boolean;
}

/**
 * Whether a child counts as stalled right now.
 *
 * Only agents that owe us something are considered: an idle, completed, failed
 * or hibernated child is silent because it has nothing to say. A busy child that
 * has never produced an event is timed from when it was prompted — the caller
 * seeds `lastEventAt` at that moment, so a child hanging on its very first
 * request is caught too.
 */
export function isStalled(input: StallInput): boolean {
	if (input.stallSeconds <= 0) return false;
	if (!input.busy) return false;
	// Blocked on us, not broken. This is the one silence that is expected.
	if (input.awaitingAnswer) return false;
	if (input.status !== "running" && input.status !== "starting" && input.status !== "stalled") {
		return false;
	}
	if (input.lastEventAt === undefined) return false;
	return input.now - input.lastEventAt >= input.stallSeconds * 1000;
}

/** How long a child has been silent, as a short human string. */
export function describeSilence(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The state transition implied by the clock, or `undefined` for "no change".
 *
 * Split out from the timer so both the periodic sweep and any event-driven
 * check agree, and so the "back to running by itself" edge is tested rather
 * than assumed.
 */
export function stallTransition(input: StallInput): "stalled" | "recovered" | undefined {
	const stalled = isStalled(input);
	if (stalled && input.status !== "stalled") return "stalled";
	if (!stalled && input.status === "stalled") return "recovered";
	return undefined;
}

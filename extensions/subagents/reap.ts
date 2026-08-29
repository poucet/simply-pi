/**
 * Deciding which finished children to let go of.
 *
 * Nothing used to tell the parent that a completed child still holds one of six
 * slots, so finished agents accumulated until something wiped them. `/reload`
 * did that wiping, which is exactly why the problem stayed invisible — and why
 * it becomes load-bearing the moment agents survive a reload (see hibernate.ts).
 *
 * Three mechanisms share this file, because they are the same judgement made at
 * three moments:
 *
 *   - the orchestrator is *asked* to decide, by an affordance line under every
 *     final result (mailbox.ts);
 *   - a completed agent nobody touched is *hibernated* after a while, freeing
 *     its process but keeping its conversation;
 *   - a spawn that would exceed the cap *reclaims* the stalest finished agent
 *     rather than failing in the orchestrator's face.
 *
 * All of it is pure so the rules can be argued with in tests rather than in
 * production: reclaiming the wrong agent destroys work.
 */

/** A completed agent untouched for this long stops its process by itself. */
export const DEFAULT_IDLE_HIBERNATE_MINUTES = 30;

/**
 * The little that a reap decision needs to know about an agent.
 *
 * Structural rather than `ManagedAgent` so the rules can be tested with plain
 * objects, and so nothing here can reach for a process by accident.
 */
export interface ReapCandidate {
	id: string;
	name: string;
	status: string;
	busy: boolean;
	/** When the child last said anything, if it ever did. */
	lastEventAt?: number;
	/** When the child settled, if it has. */
	endedAt?: number;
	startedAt: number;
	/** Whether a process is currently attached. */
	hasProcess: boolean;
}

/**
 * The moment an agent last did or was told anything.
 *
 * "Least recently active" has to mean something defensible: an agent that
 * finished long ago but was followed up on a minute ago is *not* the stalest
 * one, and reclaiming it would throw away the conversation the orchestrator is
 * evidently still using.
 */
export function lastActiveAt(agent: ReapCandidate): number {
	return Math.max(agent.lastEventAt ?? 0, agent.endedAt ?? 0, agent.startedAt);
}

/**
 * Whether an agent may be reclaimed to make room for a new one.
 *
 * Only agents that have finished cleanly, or that have already been put to sleep
 * by the idle sweep. (The caller decides which of those are worth taking: the
 * manager filters hibernated agents out before asking, because they hold no
 * process slot and closing one would destroy a conversation without freeing
 * anything.) Explicitly **not**:
 *
 *   - `running`/`starting`/`stalled` — reclaiming those destroys work in flight,
 *     and a stall is a network problem, not a dead agent;
 *   - `failed` — its transcript is the only post-mortem there is, and the S7
 *     cleanup policy deliberately keeps it;
 *   - `interrupted` — the human stopped it on purpose and may well resume it.
 */
export function isReclaimable(agent: ReapCandidate): boolean {
	if (agent.busy) return false;
	return agent.status === "completed" || agent.status === "hibernated";
}

/**
 * Which agent to close so a spawn can proceed, or why none can be.
 *
 * Returns the least recently active reclaimable agent. Ties break on id so the
 * choice is deterministic — an arbitrary victim would make the behaviour
 * impossible to reason about when two agents finished in the same millisecond.
 */
export function selectReapVictim(
	agents: readonly ReapCandidate[],
): { victim: ReapCandidate } | { victim: undefined; reason: string } {
	const live = agents.filter((agent) => agent.status !== "closed");
	const reclaimable = live.filter(isReclaimable);
	if (reclaimable.length === 0) {
		return { victim: undefined, reason: describeWhyNothingIsReclaimable(live) };
	}
	let best = reclaimable[0]!;
	for (const agent of reclaimable.slice(1)) {
		const candidate = lastActiveAt(agent);
		const incumbent = lastActiveAt(best);
		if (candidate < incumbent || (candidate === incumbent && agent.id < best.id)) best = agent;
	}
	return { victim: best };
}

/**
 * Say what is actually in the way.
 *
 * "Too many subagents" without naming them makes the orchestrator guess; the
 * counts tell it whether to let them finish, to retry a stall, or to close a
 * failure it has already read.
 */
function describeWhyNothingIsReclaimable(agents: readonly ReapCandidate[]): string {
	const counts = { running: 0, stalled: 0, failed: 0, interrupted: 0, other: 0 };
	for (const agent of agents) {
		if (agent.status === "stalled") counts.stalled += 1;
		else if (agent.status === "failed") counts.failed += 1;
		else if (agent.status === "interrupted") counts.interrupted += 1;
		else if (agent.busy || agent.status === "running" || agent.status === "starting") {
			counts.running += 1;
		} else counts.other += 1;
	}
	const parts: string[] = [];
	if (counts.running > 0) parts.push(`${counts.running} still running`);
	if (counts.stalled > 0) parts.push(`${counts.stalled} stalled (retry or close them)`);
	if (counts.failed > 0) parts.push(`${counts.failed} failed (kept for post-mortem; close them)`);
	if (counts.interrupted > 0) parts.push(`${counts.interrupted} interrupted`);
	if (counts.other > 0) parts.push(`${counts.other} busy`);
	return parts.join(", ") || "no agents are reclaimable";
}

/**
 * Whether a completed agent has been idle long enough to hibernate itself.
 *
 * Only `completed`: a failed agent has nothing to resume, an interrupted one is
 * the human's business, and anything still working is not idle. An agent with no
 * process is already asleep.
 */
export function shouldIdleHibernate(input: {
	agent: ReapCandidate;
	now: number;
	idleHibernateMinutes: number;
}): boolean {
	const { agent, now, idleHibernateMinutes } = input;
	if (idleHibernateMinutes <= 0) return false; // Disabled.
	if (agent.busy) return false;
	if (agent.status !== "completed") return false;
	if (!agent.hasProcess) return false; // Already hibernated; nothing to stop.
	return now - lastActiveAt(agent) >= idleHibernateMinutes * 60_000;
}

/** Every completed agent that the idle sweep should put to sleep right now. */
export function selectIdleHibernations(
	agents: readonly ReapCandidate[],
	now: number,
	idleHibernateMinutes: number,
): ReapCandidate[] {
	return agents.filter((agent) => shouldIdleHibernate({ agent, now, idleHibernateMinutes }));
}

import type { PendingQuestion } from "./ask.ts";
import type { ChildRpc, RpcEvent } from "./rpc.ts";

export type ContextMode = "auto" | "fresh" | "compacted" | "forked";

export type AgentStatus =
	| "starting"
	| "running"
	/** Busy, but silent for longer than `stallSeconds` — see stall.ts. */
	| "stalled"
	/** Blocked inside `ask_parent`, waiting for an answer. Not a fault. */
	| "waiting"
	| "idle"
	| "completed"
	| "failed"
	| "interrupted"
	/** Survived a parent reload: no process, but the conversation is on disk. */
	| "hibernated"
	| "closed";

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	contextTokens: number;
}

export function emptyUsage(): AgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 };
}

/** A line in the child's recent-activity feed, shown in the widget. */
export interface ActivityLine {
	at: number;
	text: string;
}

/** The parts of a child's command line that are not derived from its paths. */
export interface LaunchSpec {
	model?: string;
	thinking?: string;
	tools?: string[];
	/** Shared mission notes path, passed to the child in its environment. */
	notesPath: string;
	/**
	 * Parent extensions this child loads.
	 *
	 * The child runs with `--no-extensions` and gets these back explicitly: that
	 * is how "inherit everything except the denylist" is expressed, since the CLI
	 * has no per-extension exclude.
	 *
	 * Recorded so a child is *describable* while hibernated, not so it is frozen:
	 * a revive re-runs discovery and overwrites this (see `resolveChildExtensions`
	 * and `createClient` in manager.ts). Holding the spawn-time paths as gospel
	 * meant that moving an extension on disk silently un-equipped every hibernated
	 * child, because the launch code skipped any path that no longer existed.
	 */
	extensions?: string[];
	/**
	 * MCP servers this child may boot, by name; `["*"]` means all of them.
	 *
	 * An allowlist, empty by default — see `shared/mcp-scope.ts` for why that
	 * direction. Lives on the launch spec rather than being re-read from config at
	 * launch because it is a *per-child* decision (the orchestrator may scope one
	 * child to `notion` and its sibling to nothing), and because that is what makes
	 * it adjustable later: rewriting this field changes what the child boots on its
	 * next revive.
	 */
	mcpScope?: string[];
}

export interface ManagedAgent {
	id: string;
	/**
	 * The child's session uuid — its identity across the whole tree.
	 *
	 * `id` is a per-parent handle (and the key of the local maps); this is the
	 * thing that is unique everywhere and survives a cold restart, so it is what
	 * the registry, the mailbox and pending questions are keyed by. Optional only
	 * for records written before the uuid spine existed.
	 */
	sessionId?: string;
	/** The session uuid of the agent that spawned this one. */
	parentSessionId?: string;
	/** Display label. Unique within one parent, meaningless across the tree. */
	name: string;
	task: string;
	/**
	 * One-line label for the task, shown in listings.
	 *
	 * Distinct from a truncation of `task`: see `task-store.ts` for why a prefix
	 * makes a fleet of similarly-worded children indistinguishable.
	 */
	taskSummary?: string;
	persona?: string;
	cwd: string;
	contextMode: Exclude<ContextMode, "auto">;
	status: AgentStatus;
	model?: string;
	startedAt: number;
	endedAt?: number;
	usage: AgentUsage;
	/** Last assistant text produced by the child. */
	output: string;
	activity: ActivityLine[];
	error?: string;

	/**
	 * The child process, while there is one.
	 *
	 * Absent for a hibernated agent: it survived a parent reload as a record and
	 * a session file, and only gets a process again when something is sent to it.
	 */
	client?: ChildRpc;
	sessionFile: string;
	sessionDir: string;
	promptFile?: string;
	/**
	 * Everything needed to launch this child again on its existing session file.
	 *
	 * Kept as data rather than rebuilt from the spawn arguments because a revive
	 * happens after a reload, when the spawn call and its context are long gone.
	 */
	launch: LaunchSpec;
	/** True between prompt() and the following agent_settled. */
	busy: boolean;
	/**
	 * When the child last said anything at all.
	 *
	 * The only signal that separates "thinking" from "the network went away":
	 * a wedged provider call produces no events and never exits, so nothing else
	 * in the system notices. Seeded when the child is prompted so a first request
	 * that hangs is caught too.
	 */
	lastEventAt?: number;
	/** Set while `status === "stalled"` so the human is only told once. */
	stallNotifiedAt?: number;
	/**
	 * What this child was doing when its process went away.
	 *
	 * Recorded at the moment of hibernation, because by the time anybody looks the
	 * status says `hibernated` and that is true of a finished child and an
	 * interrupted one alike. Auto-resume needs to tell them apart: restarting the
	 * first redoes completed work, and *not* restarting the second strands it on
	 * disk indefinitely. See `resume.ts`.
	 */
	unfinishedStatus?: string;
	/**
	 * How many times auto-resume has already restarted this child.
	 *
	 * Persisted on the registry node, so it survives the very restart it counts.
	 * Without that a crash loop resets its own counter every iteration and retries
	 * forever.
	 */
	resumeAttempts?: number;
	/**
	 * The question this child is blocked on, if any.
	 *
	 * There is no timeout on `ask_parent`, so this is also what makes the block
	 * visible: it drives the `waiting` status, the strip icon, and the distinction
	 * between "blocked on us" and "the network died" in stall detection.
	 */
	pendingQuestion?: PendingQuestion;
	/**
	 * Name of the finished agent that was auto-closed to free this one's slot.
	 *
	 * Reported once, in the spawn result: reclaiming somebody's conversation is
	 * destructive and the orchestrator should hear about it from the action that
	 * caused it.
	 */
	reclaimedToStart?: string;
	/**
	 * Set by `interrupt()` until the child's `agent_settled` arrives.
	 *
	 * The abort we requested still produces a settle event; without this flag the
	 * agent flips back to "completed" and a bogus final/error result is mailed to
	 * the parent for work the parent deliberately stopped.
	 */
	abortRequested?: boolean;
}

/**
 * Everything the UI is allowed to know about the manager.
 *
 * Lives here rather than in `chat-view.ts` so the switcher strip — which is
 * pure logic and rendered in two different places — does not have to import the
 * overlay it is drawn in.
 */
export interface ChatHost {
	/** Agents in switcher order. */
	agents(): ManagedAgent[];
	/** Pending mailbox items for an agent (the unread marker). */
	unread(agentId: string): number;
	statusIcon(agent: ManagedAgent): string;
	/** Subscribe to a child's RPC event stream. */
	subscribe(agentId: string, listener: (event: RpcEvent) => void): () => void;
	/** Send text to a child: steer while it is mid-turn, prompt/follow-up otherwise. */
	send(agentId: string, text: string): Promise<void>;
	/**
	 * Everything below a direct child — its children, theirs, and so on — in tree
	 * order (depth first, each parent before its own children).
	 *
	 * Optional: a host that cannot see past its own children shows only those.
	 */
	descendants?(agent: ManagedAgent): DescendantView[];
}

/**
 * An agent below one of this process's children.
 *
 * It runs inside a child's own process, so none of its events reach us: what we
 * know comes from the registry (identity, parentage, lifecycle status) and from
 * tailing its session file (turns, cost, latest activity). Read-only by nature —
 * the only route to it is through its parent.
 */
export interface DescendantView {
	sessionId: string;
	parentSessionId: string;
	/** Display name of the parent, for "messages go through …". */
	parentName: string;
	name: string;
	/** Registry status, reconciled against the pid. */
	status: string;
	icon: string;
	/** 1 for a grandchild of this process, 2 below that, and so on. */
	depth: number;
	startedAt: number;
	/** Absent while it is still active. */
	endedAt?: number;
	turns: number;
	cost: number;
	/** Latest thing it did, from its session file; falls back to its task summary. */
	activity: string;
	sessionFile?: string;
	cwd?: string;
	model?: string;
	persona?: string;
}

export interface AgentSnapshot {
	id: string;
	sessionId?: string;
	parentSessionId?: string;
	name: string;
	task: string;
	taskSummary?: string;
	status: AgentStatus;
	cwd: string;
	contextMode: string;
	model?: string;
	usage: AgentUsage;
	output: string;
	error?: string;
	startedAt: number;
	endedAt?: number;
	lastEventAt?: number;
	/** Milliseconds since the last child event, when one has ever been seen. */
	silentForMs?: number;
	/** What it was doing when its process went away, if it was interrupted. */
	unfinishedStatus?: string;
	/** How many times auto-resume has restarted it. */
	resumeAttempts?: number;
	/** The question this child is blocked on, if it is waiting for one. */
	pendingQuestion?: PendingQuestion;
}

export function snapshot(agent: ManagedAgent): AgentSnapshot {
	return {
		id: agent.id,
		...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
		...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
		name: agent.name,
		task: agent.task,
		...(agent.taskSummary ? { taskSummary: agent.taskSummary } : {}),
		status: agent.status,
		cwd: agent.cwd,
		contextMode: agent.contextMode,
		model: agent.model,
		usage: agent.usage,
		output: agent.output,
		error: agent.error,
		startedAt: agent.startedAt,
		endedAt: agent.endedAt,
		lastEventAt: agent.lastEventAt,
		silentForMs: agent.lastEventAt === undefined ? undefined : Date.now() - agent.lastEventAt,
		unfinishedStatus: agent.unfinishedStatus,
		resumeAttempts: agent.resumeAttempts,
		pendingQuestion: agent.pendingQuestion,
	};
}

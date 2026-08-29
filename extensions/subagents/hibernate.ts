/**
 * Surviving a reload.
 *
 * A child is a separate process holding a session file on disk. Killing it
 * because the *parent* reloaded throws away work that is often minutes old and
 * always unrecoverable — `/reload` used to cost a whole batch of delegated work
 * every time it was pressed.
 *
 * So the parent hibernates instead: before the extension runtime is torn down
 * it writes one custom session entry describing every live child (name, task,
 * cwd, model, session file, usage so far), then stops the processes. On the next
 * `session_start` those records are read back and the agents reappear in the
 * strip as `hibernated`. Their transcripts are still on disk, so their chat
 * panes open and read exactly as before, and the first message sent to one
 * revives it: a fresh `pi --mode rpc` on the *existing* session file, which
 * resumes the child's whole conversation.
 *
 * Only `reason: "quit"` still kills everything — nobody is coming back for it.
 *
 * Everything in this file is pure so the policy and the serialization can be
 * tested without a terminal, a session or a child process.
 */

import type { AgentUsage, LaunchSpec, ManagedAgent } from "./types.ts";
import { emptyUsage } from "./types.ts";

/** Custom session entry type carrying the hibernated set. Not sent to the LLM. */
export const HIBERNATE_ENTRY_TYPE = "subagents-hibernated";

/** Why the extension runtime is going away (pi's `SessionShutdownEvent.reason`). */
export type ShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

/**
 * What to do with the live children.
 *
 * `stop` is the old behaviour: kill them and forget them. `hibernate` persists
 * them first so the next session can bring them back.
 */
export type ShutdownPolicy = "stop" | "hibernate";

/**
 * Only quitting is final.
 *
 * A reload keeps the same session file, so the records written here are read
 * straight back. `new`/`resume`/`fork` move to a different session: the records
 * still land in the session being left behind, so returning to it restores them
 * and the session being opened is unaffected (it has records of its own, or
 * none). An unknown reason hibernates: losing a process is worse than keeping
 * a stale record around.
 */
export function shutdownPolicy(reason: string | undefined): ShutdownPolicy {
	return reason === "quit" ? "stop" : "hibernate";
}

/**
 * Whether the shutdown should still be recorded in the registry.
 *
 * Always — including `quit`, which used to discard everything. The registry
 * lives outside any session (see registry.ts), so writing it on the way out
 * costs nothing and is the difference between "I quit pi and my four children
 * are gone" and "I quit pi, started it again, and it told me what is restorable".
 *
 * A separate function from `shutdownPolicy` because they answer different
 * questions: that one decides whether the *processes* survive, this one decides
 * whether the *record* does. On `quit` the answer is no and yes.
 */
export function persistsOnShutdown(_reason: string | undefined): boolean {
	return true;
}

/**
 * A child, as it survives the parent's restart.
 *
 * Deliberately a flat JSON value: it goes through `pi.appendEntry` into the
 * parent's session file and has to come back out of a file written by an older
 * (or newer) version of this extension.
 */
export interface HibernatedRecord {
	id: string;
	/**
	 * The child's session uuid.
	 *
	 * Optional because records written before the uuid spine existed do not have
	 * one; everything keyed by it degrades to being keyed by `id`, which is what
	 * the old behaviour was. New records always carry it.
	 */
	sessionId?: string;
	parentSessionId?: string;
	name: string;
	task: string;
	/** One-line label for the task; see `task-store.ts`. */
	taskSummary?: string;
	persona?: string;
	cwd: string;
	contextMode: string;
	model?: string;
	status: string;
	sessionFile: string;
	sessionDir: string;
	promptFile?: string;
	startedAt: number;
	endedAt?: number;
	usage: AgentUsage;
	output: string;
	error?: string;
	/** How to launch the child again; see `LaunchSpec`. */
	launch: LaunchSpec;
	/**
	 * What the child was doing when its process went away.
	 *
	 * `status` is what it is *now* — almost always `hibernated`, because that is
	 * what losing a process makes you. This is what it was *before*, and it is the
	 * only thing that distinguishes work somebody chose to stop from work a reload
	 * or a crash interrupted. Without it, auto-resume cannot tell a finished child
	 * from an unfinished one and would redo completed work.
	 */
	unfinishedStatus?: string;
	/** How many times auto-resume has already restarted this child. */
	resumeAttempts?: number;
}

/** The payload of one `subagents-hibernated` entry. */
export interface HibernatePayload {
	version: 1;
	at: number;
	/**
	 * The parent session these children belong to.
	 *
	 * A fork copies the entries into a *new* session, and both would otherwise
	 * claim the same children — two parents reviving one child would put two `pi`
	 * processes on one session file. The id survives a reload unchanged, which is
	 * the case that matters, so restoring only on a match is both safe and
	 * sufficient.
	 */
	sessionId?: string;
	agents: HibernatedRecord[];
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function launchFrom(value: any, fallbackModel?: string): LaunchSpec {
	const raw = value && typeof value === "object" ? value : {};
	const stringList = (input: unknown): string[] | undefined =>
		Array.isArray(input) ? input.filter((v: unknown): v is string => typeof v === "string") : undefined;
	const tools = stringList(raw.tools);
	// The child's inherited extensions travel with it: a revive must reproduce
	// the same agent, not re-resolve against config that changed in between.
	const extensions = stringList(raw.extensions);
	return {
		...(optionalString(raw.model) ? { model: raw.model as string } : fallbackModel ? { model: fallbackModel } : {}),
		...(optionalString(raw.thinking) ? { thinking: raw.thinking as string } : {}),
		...(tools?.length ? { tools } : {}),
		...(extensions?.length ? { extensions } : {}),
		notesPath: optionalString(raw.notesPath) ?? "",
	};
}

function usageFrom(value: any): AgentUsage {
	const usage = emptyUsage();
	if (!value || typeof value !== "object") return usage;
	for (const key of Object.keys(usage) as Array<keyof AgentUsage>) {
		const n = value[key];
		if (typeof n === "number" && Number.isFinite(n)) usage[key] = n;
	}
	return usage;
}

/** Snapshot a live agent for persistence. */
export function toRecord(agent: ManagedAgent): HibernatedRecord {
	return {
		id: agent.id,
		...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
		...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
		name: agent.name,
		task: agent.task,
		...(agent.taskSummary ? { taskSummary: agent.taskSummary } : {}),
		...(agent.persona ? { persona: agent.persona } : {}),
		cwd: agent.cwd,
		contextMode: agent.contextMode,
		...(agent.model ? { model: agent.model } : {}),
		status: agent.status,
		...(agent.unfinishedStatus ? { unfinishedStatus: agent.unfinishedStatus } : {}),
		...(agent.resumeAttempts ? { resumeAttempts: agent.resumeAttempts } : {}),
		sessionFile: agent.sessionFile,
		sessionDir: agent.sessionDir,
		...(agent.promptFile ? { promptFile: agent.promptFile } : {}),
		startedAt: agent.startedAt,
		...(agent.endedAt ? { endedAt: agent.endedAt } : {}),
		usage: { ...agent.usage },
		output: agent.output,
		...(agent.error ? { error: agent.error } : {}),
		launch: {
			...agent.launch,
			...(agent.launch.tools ? { tools: [...agent.launch.tools] } : {}),
			...(agent.launch.extensions ? { extensions: [...agent.launch.extensions] } : {}),
		},
	};
}

/**
 * Validate one record read back from a session file.
 *
 * Returns `undefined` rather than throwing: a single unreadable record must not
 * stop the other agents from being restored.
 */
export function parseRecord(value: unknown): HibernatedRecord | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const id = optionalString(raw.id);
	const name = optionalString(raw.name);
	const sessionFile = optionalString(raw.sessionFile);
	const sessionDir = optionalString(raw.sessionDir);
	// Without a session file there is nothing to revive and nothing to read, so
	// the record is not worth showing at all.
	if (!id || !name || !sessionFile || !sessionDir) return undefined;
	return {
		id,
		...(optionalString(raw.sessionId) ? { sessionId: raw.sessionId as string } : {}),
		...(optionalString(raw.parentSessionId) ? { parentSessionId: raw.parentSessionId as string } : {}),
		name,
		task: typeof raw.task === "string" ? raw.task : "",
		...(typeof raw.taskSummary === "string" ? { taskSummary: raw.taskSummary } : {}),
		...(optionalString(raw.persona) ? { persona: raw.persona as string } : {}),
		cwd: optionalString(raw.cwd) ?? process.cwd(),
		contextMode: optionalString(raw.contextMode) ?? "fresh",
		...(optionalString(raw.model) ? { model: raw.model as string } : {}),
		status: optionalString(raw.status) ?? "hibernated",
		...(optionalString(raw.unfinishedStatus)
			? { unfinishedStatus: raw.unfinishedStatus as string }
			: {}),
		...(typeof raw.resumeAttempts === "number" && raw.resumeAttempts > 0
			? { resumeAttempts: raw.resumeAttempts }
			: {}),
		sessionFile,
		sessionDir,
		...(optionalString(raw.promptFile) ? { promptFile: raw.promptFile as string } : {}),
		startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
		...(typeof raw.endedAt === "number" ? { endedAt: raw.endedAt } : {}),
		usage: usageFrom(raw.usage),
		output: typeof raw.output === "string" ? raw.output : "",
		...(optionalString(raw.error) ? { error: raw.error as string } : {}),
		launch: launchFrom(raw.launch, optionalString(raw.model)),
	};
}

export function buildPayload(
	agents: readonly ManagedAgent[],
	sessionId?: string,
	now = Date.now(),
): HibernatePayload {
	return {
		version: 1,
		at: now,
		...(sessionId ? { sessionId } : {}),
		// A child the parent already closed is gone; only agents that still have a
		// conversation worth resuming are written.
		agents: agents.filter((agent) => agent.status !== "closed").map(toRecord),
	};
}

/**
 * The hibernated set recorded in a session, newest entry wins.
 *
 * Each shutdown appends a complete list (possibly empty), so the last entry is
 * the truth: an agent closed between two reloads simply is not in the newer
 * list, and no tombstones are needed.
 */
/** Whether this session has ever recorded a hibernated set (even an empty one). */
export function hasHibernateEntry(entries: readonly any[]): boolean {
	return entries.some(
		(entry) => entry?.type === "custom" && entry.customType === HIBERNATE_ENTRY_TYPE,
	);
}

export function collectRecords(
	entries: readonly any[],
	sessionId?: string,
): HibernatedRecord[] {
	let latest: unknown;
	for (const entry of entries) {
		if (entry?.type === "custom" && entry.customType === HIBERNATE_ENTRY_TYPE) latest = entry.data;
	}
	if (!latest || typeof latest !== "object") return [];
	// A record written by another session (a fork inherited these entries) is not
	// ours to resume; the session that wrote it may still be running the child.
	const owner = (latest as any).sessionId;
	if (sessionId && typeof owner === "string" && owner !== sessionId) return [];
	const agents = (latest as any).agents;
	if (!Array.isArray(agents)) return [];
	const seen = new Set<string>();
	const records: HibernatedRecord[] = [];
	for (const value of agents) {
		const record = parseRecord(value);
		if (!record || seen.has(record.id)) continue;
		seen.add(record.id);
		records.push(record);
	}
	return records;
}

/**
 * Whether sending to this agent needs the child process brought back first.
 *
 * The distinction is not "is it hibernated" but "is there a process": a revived
 * agent whose child later died is in exactly the same position, and a running
 * one must never be re-spawned (that would fork the conversation into two
 * writers of one session file).
 */
export function needsRevive(agent: {
	status: string;
	client?: { running: boolean } | undefined;
}): boolean {
	if (agent.status === "closed") return false;
	return agent.client?.running !== true;
}

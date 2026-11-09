/**
 * Child agent lifecycle.
 *
 * Each child is a persistent `pi --mode rpc` process with its own session file
 * and (optionally) its own working directory — that last part is what makes
 * worktree-per-task delegation work. Spawning never blocks the parent: `spawn`
 * returns as soon as the prompt is accepted, and results arrive through the
 * mailbox.
 *
 * ## Liveness invariant
 *
 * **An extension must never be able to make pi uninterruptible.** Every method
 * on this class is reachable from a tool call, a command handler, an event
 * handler or a timer, all of which run on the turn that Escape and `/reload`
 * need in order to finish. So every `await` below must either observe a caller
 * `AbortSignal` or carry its own deadline — and the ones that can do both, do.
 * See the long-form statement of the rule at the top of `rpc.ts`.
 *
 * Concretely:
 *   - Everything that waits on the child answering goes through `ChildRpc`,
 *     whose requests are clamped to `DEFAULT_REQUEST_TIMEOUT_MS` and take a
 *     signal (`rpc.ts`).
 *   - `interrupt()` never lets the child's acknowledgement gate its return.
 *   - `close()`/`stopAll()`/`hibernateAll()` are bounded sweeps: a straggler is
 *     left to its own SIGKILL rather than blocking teardown.
 *   - The one genuinely unbounded wait in this feature — `ask_parent` — lives
 *     entirely on the *child* side of the process boundary. Nothing here ever
 *     awaits an answer; the parent only enqueues and routes.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	answerPath,
	answersDirectory,
	type PendingQuestion,
	questionFromUpdate,
} from "./ask.ts";
import { MCP_SCOPE_ALL, MCP_SCOPE_ENV, encodeMcpScope, parseMcpScope } from "../shared/mcp-scope.ts";
import { DEFAULT_CHILD_DENY, extensionName, partitionExtensions } from "./deny.ts";
import {
	ANSWERS_ENV,
	NOTES_ENV,
	PARENT_SESSION_ENV,
	SUBAGENT_BOOT_ENV,
	SUBAGENT_LABEL_ENV,
	readSessionHeader,
} from "./identity.ts";
import { type MailKind, Mailbox } from "./mailbox.ts";
import { Registry, type RegistryNode } from "./registry.ts";
import { readTaskFile, resolveTaskSummary, writeTaskFile } from "./task-store.ts";
import { type Persona, findPersona } from "./personas.ts";
import { ChildRpc, type RequestOptions, type RpcEvent, type RpcExit } from "./rpc.ts";
import {
	childDirectory,
	contextUsage,
	parentMessages,
	resolveMode,
	seedChildSession,
	subagentsRoot,
	summarizeForChild,
} from "./context.ts";
import { type SpawnProgressReporter, progressReporter } from "./progress.ts";
import { SummaryCache } from "./summary-cache.ts";
import {
	type AgentStatus,
	type ContextMode,
	type LaunchSpec,
	type ManagedAgent,
	emptyUsage,
	snapshot,
} from "./types.ts";
import { type HibernatedRecord, needsRevive, toRecord } from "./hibernate.ts";
import {
	DEFAULT_IDLE_HIBERNATE_MINUTES,
	type ReapCandidate,
	lastActiveAt,
	selectIdleHibernations,
	selectReapVictim,
} from "./reap.ts";
import { DEFAULT_STALL_SECONDS, describeSilence, stallTransition } from "./stall.ts";
import {
	DEFAULT_AUTO_RESUME_MAX_AGE_MINUTES,
	DEFAULT_MAX_RESUME_ATTEMPTS,
	type ResumeTrigger,
	isUnfinished,
	planResumes,
	resumePrompt,
} from "./resume.ts";
import { type MailDecision, type TransitionCause, mailForTransition } from "./transitions.ts";

const CHILD_EXTENSION = fileURLToPath(new URL("./child-extension.ts", import.meta.url));
/** pi's built-in MCP support narrowed to a child's servers; see child-mcp.ts. */
const CHILD_MCP_EXTENSION = fileURLToPath(new URL("./child-mcp.ts", import.meta.url));

/**
 * pi's built-in extensions, by the name `builtin:<name>` loads them under.
 *
 * A child is launched with `--no-extensions`, which turns the built-ins off
 * too, and pi's `DefaultPackageManager` only reports them when told their
 * names. pi does not export its list, so it is written out here; a name pi
 * drops is reported by the child as an unknown extension rather than failing.
 * Without them a child had no MCP, no `codemode` and no `tool_search`, whatever
 * its MCP scope said.
 */
export const PI_BUILTIN_EXTENSIONS = ["llama.cpp", "codemode", "tool-search", "mcp"] as const;

const BUILTIN_PREFIX = "builtin:";
const BUILTIN_MCP = `${BUILTIN_PREFIX}mcp`;
const BUILTIN_CODEMODE = `${BUILTIN_PREFIX}codemode`;

/**
 * The `-e` values a child is launched with, after its own child extension.
 *
 * Two things happen here besides passing the inherited list through:
 *
 *   - **`builtin:mcp` follows the MCP scope.** No scope: dropped, so the child
 *     boots no servers. `"*"`: kept, every configured server. Named servers:
 *     replaced by child-mcp.ts, the same builtin built to boot only those.
 *     If the user disabled `builtin:mcp`, it is not in the list and nothing
 *     brings it back.
 *   - **Built-ins are never `existsSync`-checked.** `builtin:<name>` is not a
 *     file; the check is only for replayed disk paths that may have moved.
 */
export function childExtensionArgs(
	extensions: readonly string[],
	mcpScope: readonly string[] | undefined,
	trustPaths: boolean,
	exists: (path: string) => boolean = existsSync,
): string[] {
	const scope = mcpScope ?? [];
	const result: string[] = [];
	for (const extension of extensions) {
		if (extension === BUILTIN_MCP) {
			if (scope.length === 0) continue;
			result.push(scope.includes(MCP_SCOPE_ALL) ? BUILTIN_MCP : CHILD_MCP_EXTENSION);
		} else if (extension.startsWith(BUILTIN_PREFIX) || trustPaths || exists(extension)) {
			result.push(extension);
		}
	}
	return result;
}

/**
 * The child's `--tools` allowlist, or `undefined` for pi's defaults.
 *
 * Our own tools are always re-added, because the allowlist covers extension
 * tools too. `codemode` is added for a child given MCP servers: pi exposes MCP
 * tools through `codemode` by default and activates it when a server connects,
 * but an allowlist without it stops that, and the child is left with servers it
 * cannot call. Adding it reaches no tool the allowlist excludes: codemode can
 * call only the active tools plus the MCP tools.
 */
export function childToolsArg(
	tools: readonly string[] | undefined,
	extensionArgs: readonly string[],
): string | undefined {
	if (!tools?.length) return undefined;
	const hasMcp = extensionArgs.some((arg) => arg === BUILTIN_MCP || arg === CHILD_MCP_EXTENSION);
	const codemode = hasMcp && extensionArgs.includes(BUILTIN_CODEMODE) ? ["codemode"] : [];
	return [...new Set([...tools, ...codemode, "report_to_parent", "shared_notes"])].join(",");
}

/**
 * Ceiling on the parent-context summarization call made during a `compacted`
 * spawn. A model call is the one thing here that legitimately takes tens of
 * seconds; it is also the one thing most likely to hang on a dead connection.
 */
export const SUMMARIZE_TIMEOUT_MS = 120_000;

/** Ceiling on pi's own extension discovery during a spawn. */
export const DISCOVERY_TIMEOUT_MS = 15_000;

/** Ceiling on writing an answer file (which may sit on a network filesystem). */
export const ANSWER_WRITE_TIMEOUT_MS = 10_000;

/** Ceiling on the local filesystem work that prepares (or cleans up) a child. */
export const SEED_TIMEOUT_MS = 30_000;

/**
 * How many children may hold a process at once, unless `maxOpenAgents` in
 * `subagents.json` says otherwise. Hibernated children do not count.
 */
export const DEFAULT_MAX_OPEN_AGENTS = 10;

/**
 * The most `maxOpenAgents` may be set to. Every open child is a whole `pi`
 * process with its own model traffic, so a typo like `100` must not be taken
 * at its word.
 */
export const MAX_OPEN_AGENTS_CEILING = 32;

/**
 * Validate a configured `maxOpenAgents`.
 *
 * Absent is the default, silently. Anything else that is not an integer in
 * `1..MAX_OPEN_AGENTS_CEILING` is also the default, but with a `problem` the
 * caller shows the human — a cap that quietly ignored its setting would read as
 * configuration that works.
 */
export function parseMaxOpenAgents(raw: unknown): { value: number; problem?: string } {
	if (raw === undefined) return { value: DEFAULT_MAX_OPEN_AGENTS };
	if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= MAX_OPEN_AGENTS_CEILING) {
		return { value: raw };
	}
	return {
		value: DEFAULT_MAX_OPEN_AGENTS,
		problem:
			`maxOpenAgents must be a whole number from 1 to ${MAX_OPEN_AGENTS_CEILING}; ` +
			`got ${JSON.stringify(raw)}, using ${DEFAULT_MAX_OPEN_AGENTS}`,
	};
}

export const LIMITS = {
	maxTaskChars: 16_000,
	maxNameChars: 40,
	maxActivityLines: 40,
	maxFinalResultBytes: 24 * 1024,
};

export interface SpawnOptions {
	name: string;
	task: string;
	/**
	 * A one-line label for the task, for listings.
	 *
	 * The orchestrator knows why it spawned this child, so its own words beat
	 * anything derived. Omitted, one is derived from the task's first line.
	 */
	taskSummary?: string;
	persona?: string;
	cwd?: string;
	context?: ContextMode;
	model?: string;
	tools?: string[];
	/**
	 * MCP servers this child may boot, overriding `childMcpServers`.
	 *
	 * Per-spawn because the right answer is per-child: a research child wants
	 * Notion and its sibling writing code wants nothing, and neither is a property
	 * of the install. Shaped exactly like `tools` — optional here, stored on the
	 * launch spec, replayed on revive.
	 */
	mcpServers?: string[];
	/**
	 * pi's `onUpdate`, so the slow part of a spawn is visible while it happens.
	 *
	 * Optional: every other caller (revive, tests) simply omits it.
	 */
	onUpdate?: (partial: any) => void;
}

export interface ManagerConfig {
	/**
	 * The registry every lifecycle transition is written to.
	 *
	 * Injected so tests can point it at a temp file, and so the extension can
	 * decide where the tree lives. Absent means "do not persist", which is what a
	 * unit test wants and what a headless embedder may want.
	 */
	registry?: Registry;
	/** This parent's own session uuid, recorded as the parent of every child. */
	parentSessionId?: string;
	/**
	 * This parent's working directory, recorded on every child's registry node.
	 *
	 * The one thing that lets a *later, unrelated* pi process tell "these are the
	 * children of the last run in this project" from "these belong to some other
	 * project". A child's own `cwd` cannot answer that: under the worktree flow it
	 * is deliberately somewhere else. See `registry.treeSpawnedIn`.
	 */
	parentCwd?: string;
	/**
	 * Extensions a child must not inherit, by discovery name or absolute path.
	 *
	 * Children inherit everything else the parent would auto-discover. See
	 * `deny.ts` for the matching rules and why this is a denylist rather than a
	 * set of per-extension settings.
	 */
	childDeny?: string[];
	/**
	 * MCP servers a child may boot when the spawn does not say otherwise.
	 *
	 * The global layer of a three-layer scope: this default, a per-spawn override,
	 * and a runtime change through `setMcpScope`. Absent means the empty allowlist
	 * — no servers — which is what keeps an unconfigured install behaving exactly
	 * as it did when `mcp` was denied outright. See `shared/mcp-scope.ts`.
	 */
	childMcpServers?: string[];
	/** Seconds of silence from a busy child before it is reported as stalled. */
	stallSeconds?: number;
	/** Minutes a completed child may idle before it hibernates itself; 0 disables. */
	idleHibernateMinutes?: number;
	/**
	 * How old interrupted work may be and still be auto-resumed at a cold start.
	 *
	 * Only applies to a cold start: a reload knows the process was alive moments
	 * ago. `0` disables the bound entirely. See `resume.ts`.
	 */
	autoResumeMaxAgeMinutes?: number;
	/** How many times one child may be auto-resumed before it is declared broken. */
	maxResumeAttempts?: number;
	/** Children that may hold a process at once; see `parseMaxOpenAgents`. */
	maxOpenAgents?: number;
}

export interface ManagerCallbacks {
	/** Something changed that the widget should reflect. */
	onChange(): void;
	/** A child produced a report/result while the parent may be idle. */
	onMail(agentName: string, kind: MailKind): void;
	/**
	 * A busy child has gone silent for longer than `stallSeconds`.
	 *
	 * Fired once per stall, not per sweep. It is a warning, not a death: the
	 * child is left running and recovers by itself if events resume.
	 */
	onStall?(agent: ManagedAgent, silentForMs: number): void;
	/**
	 * An agent's process was released without the human asking.
	 *
	 * `"idle"` is the idle sweep hibernating a completed child; `"reclaimed"` is
	 * a spawn closing the stalest finished child to free its slot. Both are worth
	 * saying out loud: the second one is destructive.
	 */
	onReap?(agent: ManagedAgent, kind: "idle" | "reclaimed"): void;
	/**
	 * A `childDeny` entry matched no discovered extension.
	 *
	 * Worth surfacing: a typo in a denylist fails *open*, so the child quietly
	 * inherits the thing you meant to exclude.
	 */
	onDenyMiss?(entry: string, discovered: string[]): void;
	/**
	 * A revived child's extensions are not the ones recorded when it was spawned.
	 *
	 * Fired at most once per agent. `resolved` is the new set, or `undefined` when
	 * discovery produced nothing usable and the recorded paths were kept — which
	 * is the case worth saying loudest, because those paths may not all exist.
	 */
	onExtensionDrift?(agent: ManagedAgent, recorded: string[], resolved: string[] | undefined): void;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/**
 * Notified whenever a bounded await actually hits its deadline.
 *
 * The backstop is only half the defence; the other half is knowing it fired.
 * A deadline that trips is a bug somewhere — a wedged child, a hung mount, a
 * provider that ignores its signal — and silently swallowing it is how S9 came
 * to be deprioritised in the first place. Kept module-level and best-effort so
 * that even code paths without a manager instance (there are none today, but
 * the helpers are free functions) can be observed.
 */
export type DeadlineListener = (info: { what: string; ms: number }) => void;

const deadlineListeners = new Set<DeadlineListener>();

/** Observe every bounded await that hits its deadline. Returns an unsubscribe. */
export function onDeadlineExceeded(listener: DeadlineListener): () => void {
	deadlineListeners.add(listener);
	return () => deadlineListeners.delete(listener);
}

function reportDeadline(what: string, ms: number): void {
	for (const listener of deadlineListeners) {
		try {
			listener({ what, ms });
		} catch {
			// A broken diagnostic must not become the thing that breaks liveness.
		}
	}
}

/**
 * Stop waiting after `ms`, or as soon as the caller's signal fires.
 *
 * The last line of defence for the liveness invariant: it bounds an await whose
 * underlying operation may or may not cooperate. It deliberately does **not**
 * cancel that operation — it only stops *us* waiting for it, which is exactly
 * the distinction that keeps a wedged child from wedging the parent.
 *
 * A settled promise's rejection is swallowed after we have given up, so a late
 * failure cannot surface as an unhandled rejection.
 */
function bounded<T>(promise: Promise<T>, ms: number, signal?: AbortSignal, what = "operation"): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let done = false;
		const finish = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		// Deliberately *not* unref'd. Expiring is the only way this promise settles
		// when the wrapped operation never does, so an unref'd timer would leave the
		// caller awaiting a promise the runtime has already decided nobody is waiting
		// for. The rule across this extension: a timer that *causes* a settlement is
		// ref'd; a timer that merely escalates something already in flight (the
		// SIGTERM→SIGKILL bump in `ChildRpc.stop`, the housekeeping sweep) is not.
		const timer = setTimeout(
			() =>
				finish(() => {
					reportDeadline(what, ms);
					reject(new Error(`${what} timed out after ${ms}ms`));
				}),
			ms,
		);
		function onAbort() {
			finish(() => reject(new Error(`${what} was cancelled`)));
		}
		if (signal?.aborted) return onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}

/**
 * Run a best-effort cleanup step under a hard deadline, never throwing.
 *
 * Used by the teardown paths, where the only wrong answer is to block: a
 * straggling child is left to the SIGKILL its own `stop()` already scheduled.
 */
async function bestEffort(
	promise: Promise<unknown> | undefined,
	ms: number,
	what = "cleanup",
): Promise<void> {
	if (!promise) return;
	await bounded(promise, ms, undefined, what).catch(() => {});
}

/** Project an agent onto the little that the reap rules are allowed to see. */
/**
 * What a record says the child was doing before its process went away.
 *
 * Prefers the explicit field; falls back to the recorded status for records
 * written before that field existed, and for the case that matters most — a
 * `kill -9`, where nothing ran to overwrite `running` with `hibernated`.
 */
function unfinishedFrom(record: { unfinishedStatus?: string; status: string }): string | undefined {
	if (record.unfinishedStatus) return record.unfinishedStatus;
	return isUnfinished(record.status) ? record.status : undefined;
}

function reapCandidate(agent: ManagedAgent): ReapCandidate {
	return {
		id: agent.id,
		name: agent.name,
		status: agent.status,
		busy: agent.busy,
		lastEventAt: agent.lastEventAt,
		endedAt: agent.endedAt,
		startedAt: agent.startedAt,
		hasProcess: agent.client?.running === true,
	};
}

/** One-line summary of a child tool call, for the activity feed. */
export function describeToolCall(toolName: string, args: any): string {
	if (!args || typeof args !== "object") return toolName;
	if (toolName === "bash" && typeof args.command === "string") {
		return `$ ${args.command.split("\n")[0]!.slice(0, 80)}`;
	}
	for (const key of ["path", "pattern", "query", "name", "summary"]) {
		const value = args[key];
		if (typeof value === "string") return `${toolName} ${value.slice(0, 70)}`;
	}
	return toolName;
}

/**
 * Validate a requested child name against the names already used this session.
 *
 * Names are never recycled, so a stale reference in the transcript can never
 * silently point at a different agent.
 */
export function normalizeName(raw: string, usedNames: ReadonlySet<string>): string {
	const name = raw.trim().slice(0, LIMITS.maxNameChars);
	if (!name) throw new Error("subagent name is required");
	if (!/^[\w][\w .-]*$/.test(name)) {
		throw new Error(`invalid subagent name "${raw}": use letters, digits, dot, dash, underscore`);
	}
	if (usedNames.has(name.toLowerCase())) {
		throw new Error(`subagent name "${name}" is already used in this session; pick another`);
	}
	return name;
}

export class SubagentManager {
	private agents = new Map<string, ManagedAgent>();
	readonly mailbox = new Mailbox();
	/** Names are never recycled inside one parent session, so stale references stay unambiguous. */
	private usedNames = new Set<string>();
	/** UI observers of each child's raw event stream, keyed by agent id. */
	private eventListeners = new Map<string, Set<(event: RpcEvent) => void>>();
	/** Denylist entries already reported as matching nothing; warn once, not per spawn. */
	private warnedDenyEntries = new Set<string>();
	/** Agents whose revive-time extension drift was already reported; warn once, not per revive. */
	private warnedExtensionDrift = new Set<string>();
	/** One parent-context summarization per conversation point, not per spawn. */
	private summaryCache = new SummaryCache();

	/**
	 * Summarize the parent conversation for a child.
	 *
	 * `protected` rather than inlined so tests can count the model calls without
	 * making one — which is how `summaryCache`'s fan-out behaviour is asserted.
	 * Keep it protected: `tests/manager.test.ts` overrides it.
	 */
	protected summarize(
		ctx: any,
		messages: any[],
		task: string,
		signal?: AbortSignal,
	): Promise<string> {
		return summarizeForChild(ctx, messages, task, signal);
	}

	constructor(
		private callbacks: ManagerCallbacks,
		private config: ManagerConfig = {},
	) {}

	setConfig(config: ManagerConfig): void {
		this.config = config;
	}

	list(): ManagedAgent[] {
		return [...this.agents.values()];
	}

	snapshots() {
		return this.list().map(snapshot);
	}

	/**
	 * Resolve a reference to one of *this parent's* children.
	 *
	 * The order encodes the identity model. A session uuid is unique across the
	 * whole tree and is checked first; the local agent id is next; a display name
	 * is checked last and only against this manager's own children, because names
	 * are labels chosen by the spawning model and two parents can each have a
	 * `reviewer`. That last restriction is exactly what makes duplicate names
	 * across the tree harmless: a name never escapes the parent that coined it.
	 */
	get(nameOrId: string): ManagedAgent | undefined {
		if (!nameOrId) return undefined;
		const key = nameOrId.toLowerCase();
		return (
			this.list().find((a) => a.sessionId === nameOrId) ??
			this.agents.get(nameOrId) ??
			this.list().find((a) => a.id === nameOrId) ??
			this.list().find((a) => a.name.toLowerCase() === key)
		);
	}

	/** Resolve a display name to a session uuid, within this parent's children. */
	resolveSessionId(name: string): string | undefined {
		return this.get(name)?.sessionId;
	}

	/** Find a child by session uuid alone — no name fallback, no ambiguity. */
	bySessionId(sessionId: string): ManagedAgent | undefined {
		return this.list().find((agent) => agent.sessionId === sessionId);
	}

	require(nameOrId: string): ManagedAgent {
		const agent = this.get(nameOrId);
		if (!agent) {
			const known = this.list().map((a) => a.name).join(", ") || "none";
			throw new Error(`unknown subagent "${nameOrId}". Open subagents: ${known}`);
		}
		return agent;
	}

	/**
	 * Children that hold a process slot.
	 *
	 * A hibernated agent does not: it is a record and a file. Counting them would
	 * mean a reload with a full table of children left you unable to delegate anything until
	 * you closed them one by one.
	 */
	get openCount(): number {
		return this.list().filter((a) => a.status !== "closed" && a.status !== "hibernated").length;
	}

	/** The process-slot cap in force: `maxOpenAgents` from the config, else the default. */
	get maxOpenAgents(): number {
		return parseMaxOpenAgents(this.config.maxOpenAgents).value;
	}

	/**
	 * Slots promised to a spawn or revive that has passed the cap check but has
	 * not yet registered a process.
	 *
	 * Both paths await (summarizing, seeding, discovery, process start) between
	 * checking the cap and the moment their agent starts counting in `openCount`.
	 * Without a reservation taken synchronously at the check, a batch of spawns
	 * issued as parallel tool calls all saw the same free table and all got in.
	 */
	private reservedSlots = 0;

	/** Slots taken, including ones promised to work still starting up. */
	private get slotsInUse(): number {
		return this.openCount + this.reservedSlots;
	}

	/** Take one reserved slot; the returned function gives it back, at most once. */
	private reserveSlot(): () => void {
		this.reservedSlots += 1;
		let held = true;
		return () => {
			if (!held) return;
			held = false;
			this.reservedSlots -= 1;
		};
	}

	/** Path of the scratchpad shared by the parent and every child in this session. */
	sharedNotesPath(parentSessionId: string): string {
		return join(subagentsRoot(), "sessions", parentSessionId, "SHARED_NOTES.md");
	}

	// ---------------------------------------------------------- the registry --

	/**
	 * Project an agent onto its registry node.
	 *
	 * Everything a cold start needs to *show* the agent and to *revive* it, and
	 * nothing else: the pid (liveness), the session file (revivability), the
	 * launch spec (how), plus the labels a human reads.
	 */
	private registryNode(agent: ManagedAgent): RegistryNode {
		return {
			// Falls back to the local id only for an agent restored from a record
			// written before the uuid spine existed; new agents always have a uuid.
			sessionId: agent.sessionId ?? agent.id,
			...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
			name: agent.name,
			// The task text itself is in `task.md` beside the child's transcript; only
			// the label rides in the registry. See `task-store.ts`.
			...(agent.taskSummary ? { taskSummary: agent.taskSummary } : {}),
			cwd: agent.cwd,
			// Taken from the config rather than from the agent on purpose: whoever is
			// writing this node is this node's parent now, including after a cold start
			// adopted it. An agent restored into a different project is that project's
			// to keep, and the next cold start there should find it again.
			...(this.config.parentCwd ? { parentCwd: this.config.parentCwd } : {}),
			...(agent.model ? { model: agent.model } : {}),
			...(agent.persona ? { persona: agent.persona } : {}),
			contextMode: agent.contextMode,
			sessionFile: agent.sessionFile,
			sessionDir: agent.sessionDir,
			...(agent.promptFile ? { promptFile: agent.promptFile } : {}),
			agentId: agent.id,
			status: agent.status,
			// Both are auto-resume's inputs and both must survive a `kill -9`, so they
			// go on the node rather than staying in memory. `resumeAttempts` in
			// particular has to survive the restart it is counting, or a crash loop
			// resets its own counter every iteration and retries forever.
			...(agent.unfinishedStatus ? { unfinishedStatus: agent.unfinishedStatus } : {}),
			...(agent.resumeAttempts ? { resumeAttempts: agent.resumeAttempts } : {}),
			lastActiveAt: Date.now(),
			startedAt: agent.startedAt,
			...(agent.endedAt ? { endedAt: agent.endedAt } : {}),
			// Absent once the process is gone; `Registry.upsert` treats that as a real
			// transition rather than a field nobody restated.
			...(agent.client?.running && agent.client.pid ? { pid: agent.client.pid } : {}),
			usage: { ...agent.usage },
			// Output is deliberately not persisted: it was the largest field in the file
			// and a lossy copy of the last text block of `session.jsonl`, which sits in
			// the same directory. Rewriting it on every turn was the bulk of the churn.
			...(agent.error ? { error: agent.error } : {}),
			launch: agent.launch,
		};
	}

	/**
	 * Write one agent's current state to the registry.
	 *
	 * Called on *every* lifecycle transition rather than only at shutdown: a
	 * `kill -9` runs no shutdown hook, so a registry written only on the way out
	 * is missing precisely when it is needed. Synchronous and small (one rename
	 * of a few kilobytes), and failures are swallowed inside `Registry` — an
	 * index of things that exist elsewhere must never break the things it indexes.
	 */
	private recordTransition(agent: ManagedAgent): void {
		const registry = this.config.registry;
		if (!registry) return;
		try {
			registry.upsert(this.registryNode(agent));
		} catch {
			/* see the doc comment: the registry is never load-bearing */
		}
	}

	/**
	 * The only way an agent's status changes.
	 *
	 * Assigning `agent.status` directly is how a stall was detected, shown to the
	 * human, and never mailed to the orchestrator. Every transition now names its
	 * cause and consults the table in transitions.ts, which is a
	 * `Record<AgentStatus, …>`: a status with no mail decision does not compile,
	 * and a deliberate silence is an entry with a reason rather than an absence.
	 *
	 * `content` is only consulted when the table says something is published; the
	 * caller passes it unconditionally because computing it is cheap and making it
	 * conditional is how the two halves drift apart.
	 *
	 * The table's `persist` column is honoured here too, and it is not decoration:
	 * `stopAll` checkpoints the whole tree *before* marking everything closed so
	 * that `kill pi && pi` can offer the conversations back, and writing those
	 * `closed` statuses through would erase exactly what the checkpoint was for.
	 */
	private transition(
		agent: ManagedAgent,
		status: AgentStatus,
		cause: TransitionCause,
		content?: string,
		/** Extra mail fields (only `questionId` today) for kinds that need them. */
		extra?: { questionId?: string },
	): MailDecision {
		agent.status = status;
		const decision = mailForTransition(status, cause);
		if (decision.publish !== "silent") {
			this.mailbox.publish({
				kind: decision.publish,
				agentId: agent.id,
				agentName: agent.name,
				...(extra?.questionId ? { questionId: extra.questionId } : {}),
				content: truncate(
					content?.trim() || `"${agent.name}" is now ${status}.`,
					LIMITS.maxFinalResultBytes,
				),
			});
			this.callbacks.onMail(agent.name, decision.publish);
		}
		if (decision.persist) this.recordTransition(agent);
		return decision;
	}

	/** Drop an agent (and anything it spawned) from the registry, on close. */
	private forgetInRegistry(agent: ManagedAgent): void {
		const registry = this.config.registry;
		if (!registry) return;
		try {
			registry.remove(agent.sessionId ?? agent.id);
		} catch {
			/* best effort */
		}
	}

	/**
	 * Re-write every live agent. Used at shutdown, including on `quit`.
	 *
	 * A no-op with no children, so merely starting and stopping pi does not
	 * rewrite the registry (and, through `updatedAt`, make an untouched tree look
	 * freshly modified).
	 */
	checkpoint(): void {
		const agents = this.list();
		if (agents.length === 0) return;
		for (const agent of agents) this.recordTransition(agent);
	}

	async spawn(
		ctx: any,
		personas: Persona[],
		options: SpawnOptions,
		signal?: AbortSignal,
	): Promise<ManagedAgent> {
		// Prefer the tool's own signal; `ctx.signal` is the fallback for callers that
		// only have a context (a command handler, say).
		const abort: AbortSignal | undefined = signal ?? ctx?.signal;
		abort?.throwIfAborted();
		const name = normalizeName(options.name, this.usedNames);
		const task = String(options.task ?? "").trim().slice(0, LIMITS.maxTaskChars);
		if (!task) throw new Error("subagent task is required");

		const persona = options.persona ? findPersona(personas, options.persona) : undefined;
		if (options.persona && !persona) {
			const known = personas.map((p) => p.name).join(", ") || "none";
			throw new Error(`unknown persona "${options.persona}". Available personas: ${known}`);
		}

		const cwd = options.cwd ? this.resolveCwd(ctx.cwd, options.cwd) : ctx.cwd;

		// Deliberately after every cheap validation: reclaiming ends somebody's
		// conversation, and a spawn that was going to fail on a typo must not cost
		// an agent. Everything above this line throws without side effects.
		//
		// A full table used to be the orchestrator's problem to notice mid-
		// delegation; taking the stalest *finished* agent is what a careful human
		// would do anyway.
		//
		// `makeRoom` reserves the slot before it awaits anything; the reservation is
		// handed over when the agent registers, or given back if it never does.
		const { reclaimed, release } = await this.makeRoom();
		try {
			return await this.launchReserved(ctx, options, { name, task, persona, cwd, abort, reclaimed, release });
		} finally {
			release();
		}
	}

	/**
	 * Everything `spawn` does once a slot is reserved for it.
	 *
	 * Split out so the reservation has one `finally` around all of it; `release`
	 * is called the moment the agent itself counts in `openCount`.
	 */
	private async launchReserved(
		ctx: any,
		options: SpawnOptions,
		prepared: {
			name: string;
			task: string;
			persona: Persona | undefined;
			cwd: string;
			abort: AbortSignal | undefined;
			reclaimed: string | undefined;
			release: () => void;
		},
	): Promise<ManagedAgent> {
		const { name, task, persona, cwd, abort, reclaimed, release } = prepared;
		const seed = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 16);
		let id: string;
		do {
			id = `${seed || "agent"}-${randomBytes(4).toString("hex")}`;
		} while (this.agents.has(id));

		const parentSessionId = String(ctx.sessionManager.getSessionId());
		const notesPath = this.sharedNotesPath(parentSessionId);
		mkdirSync(join(subagentsRoot(), "sessions", parentSessionId), { recursive: true, mode: 0o700 });

		// --- context inheritance -------------------------------------------------
		const report: SpawnProgressReporter = progressReporter(options.onUpdate);
		report({ stage: "context", name });
		const messages = parentMessages(ctx);
		// Precedence: this spawn's request, else the persona's frontmatter default,
		// else auto. Token-first: forking costs nothing and loses nothing, so it
		// stays the default until a copy would not comfortably fit. See context.ts.
		const mode = resolveMode(
			options.context ?? persona?.context ?? "auto",
			messages.length,
			contextUsage(ctx),
		);
		let summary: string | undefined;
		if (mode === "compacted") {
			const leafId = ctx.sessionManager?.getLeafId?.() ?? null;
			const cached = this.summaryCache.has(leafId);
			report({
				stage: cached ? "summary-cached" : "summarizing",
				name,
				messages: messages.length,
			});
			// Keyed on the parent leaf, so a fan-out of N agents from one conversation
			// point summarizes once instead of N times. Bounded on top of the signal,
			// not instead of it: a provider that ignores its signal would otherwise
			// hold the spawn open indefinitely.
			summary = await this.summaryCache.get(leafId, () =>
				bounded(
					this.summarize(ctx, messages, task, abort),
					SUMMARIZE_TIMEOUT_MS,
					abort,
					"summarizing parent context for the child",
				),
			);
		}
		report({ stage: "seeding", name, mode });
		// Local filesystem work, but bounded all the same: `~/.pi` is sometimes a
		// network home directory, and an fs call that never returns is exactly as
		// wedging as an RPC call that never returns.
		const seeded = await bounded(
			seedChildSession({
				ctx,
				directory: childDirectory(parentSessionId, id),
				mode,
				messages,
				summary,
				cwd,
			}),
			SEED_TIMEOUT_MS,
			abort,
			"seeding the child's session",
		);

		// --- system prompt -------------------------------------------------------
		const promptFile = join(seeded.directory, "system-prompt.md");
		await bounded(
			writeFile(promptFile, this.buildSystemPrompt(name, task, cwd, notesPath, persona), {
				encoding: "utf-8",
				mode: 0o600,
			}),
			SEED_TIMEOUT_MS,
			abort,
			"writing the child's system prompt",
		);

		// --- task ----------------------------------------------------------------
		// Beside the transcript rather than in the registry: the registry is rewritten
		// on every transition of every child on this machine, and a task is written
		// once and read by two callers. Best-effort and deliberately not bounded with
		// the others — a task we failed to persist costs the revive nudge some
		// context, which is not worth failing a spawn over.
		writeTaskFile(seeded.directory, task);

		// --- process -------------------------------------------------------------
		const launch: LaunchSpec = {
			...(() => {
				const model = options.model ?? persona?.model ?? this.parentModel(ctx);
				return model ? { model } : {};
			})(),
			...(!options.model && !persona?.model && ctx.thinkingLevel
				? { thinking: String(ctx.thinkingLevel) }
				: {}),
			...((options.tools ?? persona?.tools)?.length
				? { tools: options.tools ?? persona?.tools }
				: {}),
			notesPath,
			// Recorded so the child is describable while hibernated. Re-resolved on
			// every revive, because a path frozen here goes stale the moment an
			// extension moves — see `refreshChildExtensions`.
			extensions: await this.resolveChildExtensions(ctx, abort),
			// Most specific wins: this spawn's request, else the install default, else
			// nothing. `?? []` rather than leaving it absent so the decision is
			// explicit on the record and a later default cannot retroactively widen a
			// child that was already launched.
			mcpScope: parseMcpScope(options.mcpServers) ?? this.config.childMcpServers ?? [],
		};

		const client = this.createClient({
			name,
			cwd,
			sessionFile: seeded.sessionFile,
			sessionDir: seeded.directory,
			promptFile,
			launch,
			// Discovery ran moments ago, in this process: these paths were just found.
			trustExtensions: true,
			parentSessionId,
		});

		const agent: ManagedAgent = {
			id,
			// Recorded at spawn, from the header we just wrote: both ends now know
			// both ids, so the relationship is explicit rather than inferred from a
			// name the model happened to choose.
			sessionId: seeded.sessionId,
			parentSessionId,
			name,
			task,
			taskSummary: resolveTaskSummary(task, options.taskSummary),
			persona: persona?.name,
			cwd,
			contextMode: mode,
			status: "starting",
			model: launch.model,
			startedAt: Date.now(),
			usage: emptyUsage(),
			output: "",
			activity: [],
			client,
			sessionFile: seeded.sessionFile,
			sessionDir: seeded.directory,
			promptFile,
			launch,
			busy: false,
		};

		this.agents.set(id, agent);
		// The agent now counts in `openCount` itself, so the reservation is spent.
		release();
		this.usedNames.add(name.toLowerCase());
		this.attach(agent, client);

		try {
			report({ stage: "starting", name });
			await client.start(abort);
			// Silent by the table: the spawn tool's own result reports the start.
			this.transition(agent, "running", "spawn");
			agent.busy = true;
			agent.lastEventAt = Date.now();
			// Bounded and cancellable by `ChildRpc.send`: a child that comes up but
			// never acknowledges its first prompt fails the spawn instead of hanging it.
			await client.prompt(this.firstPrompt(name, task, mode), undefined, { signal: abort });
			report({ stage: "accepted", name });
		} catch (error) {
			let detail = error instanceof Error ? error.message : String(error);
			const stderr = client.getStderr().trim();
			if (stderr) detail += `\nstderr: ${stderr.slice(-2000)}`;
			// A child that never took its task must not linger: it would hold a slot
			// (openCount) and leave a process and a session directory behind.
			await bestEffort(client.stop(1000), 3_000, `stopping the failed spawn of "${name}"`);
			this.mailbox.drain(id); // The exit handler may already have mailed the crash.
			this.agents.delete(id);
			this.eventListeners.delete(id);
			await bestEffort(seeded.cleanup(), SEED_TIMEOUT_MS, `cleaning up the failed spawn of "${name}"`);
			this.callbacks.onChange();
			throw new Error(`failed to start subagent "${name}": ${detail}`);
		}

		if (reclaimed) agent.reclaimedToStart = reclaimed;
		// The first lifecycle write: from here on the child exists on disk for any
		// process that reads the registry, even if this one is killed outright.
		this.recordTransition(agent);
		this.callbacks.onChange();
		return agent;
	}

	/**
	 * Free a slot for a spawn, or explain why none can be freed.
	 *
	 * Returns the name of the agent that was closed, if any. The close goes
	 * through `close()` rather than a private shortcut, so an auto-reap cleans up
	 * *exactly* as an explicit close does — including keeping a failed child's
	 * session directory, which is why failed children are never victims in the
	 * first place.
	 */
	private async makeRoom(): Promise<{ reclaimed: string | undefined; release: () => void }> {
		// Check and reserve with no await in between: that gap is what let a batch
		// of parallel spawns all pass the check against the same table.
		if (this.slotsInUse < this.maxOpenAgents) return { reclaimed: undefined, release: this.reserveSlot() };
		// Only agents that actually hold a slot are worth taking: hibernated ones
		// are excluded from `openCount`, so closing one would destroy a conversation
		// without freeing anything.
		const choice = selectReapVictim(
			this.list()
				.filter((agent) => agent.status !== "hibernated")
				.map(reapCandidate),
		);
		if (!choice.victim) {
			throw new Error(
				`too many open subagents (${this.slotsInUse}/${this.maxOpenAgents}) and none can be ` +
					`reclaimed: ${choice.reason}. Close one before spawning.`,
			);
		}
		const victim = this.get(choice.victim.id);
		const release = this.reserveSlot();
		if (!victim) return { reclaimed: undefined, release };
		try {
			this.callbacks.onReap?.(victim, "reclaimed");
		} catch {
			/* the spawn result names it too */
		}
		try {
			// `close` marks the victim closed synchronously, before its first await,
			// so its slot is free — and ours — before any other spawn can look.
			await this.close(victim.id);
		} catch (error) {
			release();
			throw error;
		}
		return { reclaimed: victim.name, release };
	}

	/**
	 * Ask pi which extensions it would load here, minus the denylist.
	 *
	 * Uses pi's own `DefaultPackageManager`, so the user directory, the project
	 * directory, the `extensions` setting and installed packages are all resolved
	 * by the code that owns those rules rather than by a copy of them here.
	 *
	 * Failure is not fatal: a child with no inherited extensions still works (it
	 * just loses provider config), and refusing to spawn because discovery hiccuped
	 * would be worse than a degraded child that says so.
	 *
	 * `protected` for the same reason `summarize` is: it reaches into pi's package
	 * manager and the filesystem, so tests substitute it rather than stand up a
	 * real extension tree. Keep it protected — `tests/revive.test.ts` overrides it.
	 */
	protected async resolveChildExtensions(ctx: any, signal?: AbortSignal): Promise<string[]> {
		try {
			// The whole call is bounded, import included: this is somebody else's code
			// walking the filesystem and reading package manifests, and a hung network
			// mount is not a reason the parent cannot press Escape. "skip" rather than
			// "install" so spawning never starts a package install behind your back.
			const resolved = await bounded(
				(async () => {
					const pi = await import("@earendil-works/pi-coding-agent");
					const agentDir = pi.getAgentDir();
					const settingsManager = pi.SettingsManager.create(ctx.cwd, agentDir);
					const packageManager = new pi.DefaultPackageManager({
						cwd: ctx.cwd,
						agentDir,
						settingsManager,
						// Reported as `builtin:<name>`, enabled unless the user's
						// `extensions` setting turns one off; see PI_BUILTIN_EXTENSIONS.
						builtinExtensions: [...PI_BUILTIN_EXTENSIONS],
					});
					return await packageManager.resolve(async () => "skip");
				})(),
				DISCOVERY_TIMEOUT_MS,
				signal,
				"resolving the child's extensions",
			);
			const discovered = resolved.extensions
				.filter((entry: any) => entry.enabled)
				.map((entry: any) => String(entry.path));

			// This extension is no longer excluded from the list. A child inheriting it
			// gets the `subagent` tool and can delegate in turn, which is the decision
			// that was made: subagents may spawn subagents. What the child does *not*
			// get is the UI — `PI_SUBAGENT=1` suppresses the widget, the editor, the
			// footer status and `/agents` inside a child process (see index.ts). Add it
			// to `childDeny` to opt out per-project.
			const partition = partitionExtensions(
				discovered,
				this.config.childDeny ?? DEFAULT_CHILD_DENY,
			);
			// A mistyped entry denies nothing at all, which is a silent way to get
			// more than you asked for. Said once per session, not once per spawn.
			for (const entry of partition.unmatched) {
				if (this.warnedDenyEntries.has(entry)) continue;
				this.warnedDenyEntries.add(entry);
				this.callbacks.onDenyMiss?.(entry, discovered.map(extensionName));
			}
			return partition.allowed;
		} catch (error) {
			// A cancelled spawn is not a discovery hiccup: propagate it, or Escape
			// would silently produce a child with no inherited extensions instead of
			// no child at all.
			if (signal?.aborted) throw error;
			return [];
		}
	}

	/**
	 * Re-resolve a hibernated child's extensions before it is launched again.
	 *
	 * The launch spec records absolute paths captured at spawn. `createClient`
	 * skips any that no longer exist, which sounds defensive and is in fact the
	 * bug: move an extension on disk — reorganise a directory, split a repo — and
	 * every hibernated child silently revives *without* it. Nothing failed,
	 * nothing was logged, the child was just quietly less capable than the one
	 * that hibernated.
	 *
	 * So a revive asks discovery again instead of replaying a stale answer. That
	 * is the reverse of the original decision ("reproduce the same child rather
	 * than re-resolve against config that may have changed"), and deliberately:
	 * re-resolving can at worst hand the child a *different* extension set, which
	 * is visible and reported below, while replaying can hand it a *smaller* one,
	 * which is not.
	 *
	 * Never fatal. Discovery is bounded and can time out; a child that cannot be
	 * revived is strictly worse than one revived on its last known-good paths, so
	 * failure falls back to exactly the old behaviour.
	 *
	 * Returns whether the resulting paths can be trusted as fresh — see
	 * `trustExtensions` in `createClient`.
	 */
	private async refreshChildExtensions(agent: ManagedAgent, signal?: AbortSignal): Promise<boolean> {
		const recorded = agent.launch.extensions ?? [];
		let resolved: string[];
		try {
			// `cwd` is the child's, not the parent's: discovery is project-scoped, and
			// under the worktree flow the child deliberately lives somewhere else.
			resolved = await this.resolveChildExtensions({ cwd: agent.cwd }, signal);
		} catch (error) {
			// A cancelled revive is the human pressing Escape, not a discovery hiccup.
			if (signal?.aborted) throw error;
			return false;
		}
		// An empty result is indistinguishable from "discovery failed and swallowed
		// it" (`resolveChildExtensions` returns `[]` for both), so it is not allowed
		// to strip a child that previously had extensions. The recorded paths are the
		// better guess in that case, and being untrusted they stay `existsSync`-filtered.
		if (resolved.length === 0 && recorded.length > 0) {
			this.reportExtensionDrift(agent, recorded, undefined);
			return false;
		}

		const before = [...recorded].sort();
		const after = [...resolved].sort();
		const changed = before.length !== after.length || before.some((path, i) => path !== after[i]);
		// Written back so the record stops being stale: the next cold start, the
		// widget and the registry all read the paths this child actually launched
		// with, not the ones it was born with.
		agent.launch = { ...agent.launch, extensions: resolved };
		if (changed) this.reportExtensionDrift(agent, recorded, resolved);
		return true;
	}

	/**
	 * Say out loud that a revived child's extensions are not what was recorded.
	 *
	 * The failure being fixed is a *silent* drop, so replacing it with a silent
	 * re-resolution would be no better. Same shape as `onDenyMiss`: at most once
	 * per agent per session, because a child that hibernates and revives every few
	 * minutes would otherwise repeat itself forever.
	 */
	private reportExtensionDrift(
		agent: ManagedAgent,
		recorded: readonly string[],
		/** The new set, or `undefined` when discovery gave nothing usable. */
		resolved: readonly string[] | undefined,
	): void {
		if (this.warnedExtensionDrift.has(agent.id)) return;
		this.warnedExtensionDrift.add(agent.id);
		try {
			this.callbacks.onExtensionDrift?.(agent, [...recorded], resolved ? [...resolved] : undefined);
		} catch {
			/* Reporting a revive must never fail the revive. */
		}
	}

	/**
	 * Build the child's command line and RPC client.
	 *
	 * Shared by `spawn` and `revive` on purpose: a revived child must get exactly
	 * the same flags as the original, most importantly the same `--session` file,
	 * or it resumes with a different (or empty) conversation.
	 */
	private createClient(target: {
		name: string;
		cwd: string;
		sessionFile: string;
		sessionDir: string;
		promptFile?: string;
		launch: LaunchSpec;
		/**
		 * Whether `launch.extensions` came from discovery just now.
		 *
		 * True for a spawn and for a revive that re-resolved successfully; false when
		 * a revive fell back to the recorded paths, which may point at files that
		 * have since moved. See the `existsSync` note below.
		 */
		trustExtensions?: boolean;
		/** The spawning session's uuid, so the child can key the registry by it. */
		parentSessionId?: string;
	}): ChildRpc {
		const args = [
			"--session",
			target.sessionFile,
			"--session-dir",
			target.sessionDir,
		];
		// A revived child whose prompt file was cleaned up still resumes; it just
		// leans on the protocol already recorded in its own transcript.
		if (target.promptFile && existsSync(target.promptFile)) {
			args.push("--append-system-prompt", target.promptFile);
		}
		// "Inherit minus a denylist", expressed the only way the CLI allows: turn
		// discovery off, then pass back every extension that survived the denylist.
		// The survivors come from pi's *own* discovery (see deny.ts), so this is not
		// a reimplementation of its resolution order and cannot drift from it.
		//
		// These paths are re-resolved on every revive rather than replayed from the
		// spawn (see `refreshChildExtensions`). They used to be frozen at spawn time,
		// on the theory that a revive should reproduce the same child rather than
		// re-resolve against config that had changed underneath it. That theory had a
		// hole: a path that no longer exists was skipped by the `existsSync` below,
		// silently, so simply *moving* an extension on disk un-equipped every
		// hibernated child with no warning anywhere.
		//
		// `trustExtensions` says the list came straight out of discovery, which only
		// ever names files it just found. Re-checking those would be a second opinion
		// on a question already answered — and a wrong one under a slow network mount,
		// where `existsSync` can fail on a file that is perfectly loadable. The check
		// is kept only for the untrusted case: a spawn-time list replayed because
		// discovery could not be re-run, where a dead path is genuinely likely.
		args.push("--no-extensions");
		args.push("-e", CHILD_EXTENSION); // Never denied: it is how the child talks to us.
		const extensionArgs = childExtensionArgs(
			target.launch.extensions ?? [],
			target.launch.mcpScope,
			target.trustExtensions === true,
		);
		for (const extension of extensionArgs) args.push("-e", extension);
		if (target.launch.model) args.push("--model", target.launch.model);
		if (target.launch.thinking) args.push("--thinking", target.launch.thinking);
		const tools = childToolsArg(target.launch.tools, extensionArgs);
		if (tools) args.push("--tools", tools);
		return new ChildRpc({
			cwd: target.cwd,
			args,
			env: {
				// The boot flag, and *only* a boot flag: it says "you are a subagent"
				// and nothing about which one. The UI guard in index.ts runs inside the
				// extension factory, before any session exists, so it genuinely cannot
				// ask the session — this is the one bit it is allowed to have. Real
				// identity travels in the session header (see identity.ts).
				[SUBAGENT_BOOT_ENV]: "1",
				// A label, used for log lines and the author field of shared notes.
				// Deliberately no longer load-bearing: nothing keys off it.
				[SUBAGENT_LABEL_ENV]: target.name,
				...(target.parentSessionId ? { [PARENT_SESSION_ENV]: target.parentSessionId } : {}),
				[NOTES_ENV]: target.launch.notesPath,
				[ANSWERS_ENV]: answersDirectory(target.sessionDir),
				// Which MCP servers this child may boot. Always set, even when empty:
				// the child's mcp extension reads "unset" as an empty allowlist anyway,
				// but writing it explicitly keeps a stray `PI_SUBAGENT_MCP` in the
				// parent's own environment from leaking into children. Per-process by
				// construction, which is the point: two concurrent children with
				// different scopes cannot race, because there is no shared file to race
				// over. See shared/mcp-scope.ts.
				[MCP_SCOPE_ENV]: encodeMcpScope(target.launch.mcpScope),
			},
		});
	}

	// ---------------------------------------------------------- hibernation --

	/**
	 * Bring hibernated agents back as records: visible, readable, revivable.
	 *
	 * No process is started here. A reload with four children would otherwise
	 * spawn four `pi` processes before the human has typed anything, and most
	 * reloads are followed by looking at results rather than by more delegation.
	 * The child's transcript is on disk, so its chat pane works immediately.
	 */
	restore(
		records: readonly HibernatedRecord[],
		/**
		 * How the parent came back.
		 *
		 * A reload continues the same conversation, so the orchestrator already knows
		 * these agents and is told nothing. A cold start does not: the previous
		 * parent is gone and the transcript with it, so children reappearing out of
		 * the registry are genuinely news — without it the orchestrator spawns
		 * duplicates of work already in flight.
		 */
		cause: TransitionCause = "reload-restore",
	): ManagedAgent[] {
		const restored: ManagedAgent[] = [];
		for (const record of records) {
			if (this.agents.has(record.id)) continue;
			if (!existsSync(record.sessionFile)) continue; // Nothing left to resume.
			const agent: ManagedAgent = {
				id: record.id,
				// A record written before the uuid spine has no session id in it; read it
				// back out of the child's own session header, which has had one all along.
				sessionId: record.sessionId ?? readSessionHeader(record.sessionFile)?.id,
				parentSessionId: record.parentSessionId ?? this.config.parentSessionId,
				name: record.name,
				task: record.task,
				...(record.taskSummary ? { taskSummary: record.taskSummary } : {}),
				persona: record.persona,
				cwd: record.cwd,
				contextMode: record.contextMode as ManagedAgent["contextMode"],
				// Overwritten by the `transition` below, which is what decides the mail.
				// Kept here so the object is never momentarily statusless.
				status: "hibernated",
				// What it was doing before the process went away. A record written by an
				// older version has no such field, so fall back to its recorded status —
				// which after a crash *is* the unfinished one, frozen at the moment of
				// death, because nothing ran to overwrite it.
				...(unfinishedFrom(record) ? { unfinishedStatus: unfinishedFrom(record) } : {}),
				...(record.resumeAttempts ? { resumeAttempts: record.resumeAttempts } : {}),
				model: record.model,
				startedAt: record.startedAt,
				endedAt: record.endedAt,
				usage: { ...record.usage },
				output: record.output,
				activity: [],
				error: record.error,
				sessionFile: record.sessionFile,
				sessionDir: record.sessionDir,
				promptFile: record.promptFile,
				launch: record.launch,
				busy: false,
			};
			this.agents.set(agent.id, agent);
			// Reserved even across a reload: a stale reference in the transcript must
			// never resolve to a different agent than it did before.
			this.usedNames.add(agent.name.toLowerCase());
			// A restore is a lifecycle transition like any other: the registry must
			// agree that this node has no process before anybody reads it, and the
			// table — not this loop — decides whether the orchestrator hears about it.
			//
			// A child that failed or was interrupted keeps saying so: hibernation is
			// about the missing process, not about forgetting what happened.
			this.transition(
				agent,
				record.status === "failed" ? "failed" : "hibernated",
				cause,
				`"${agent.name}" is back from a previous run of pi, asleep and revivable. ` +
					// The label when that is all there is (a cold start whose task file is
					// gone), the full text when it was read back. The last result is not
					// restated: it is in the child's transcript, and the actionable part of
					// this message is what the child was for.
					`Its task was: ${record.task || record.taskSummary || "(not recorded)"}`,
			);
			restored.push(agent);
		}
		if (restored.length > 0) this.callbacks.onChange();
		return restored;
	}

	/**
	 * Rebuild agents from registry nodes after a cold start.
	 *
	 * The registry describes children by session uuid, which is all a *different*
	 * pi process can rely on: the previous parent's session file is gone (or was
	 * never reopened) and its in-memory names died with it. Nodes are converted to
	 * the same `HibernatedRecord` shape a reload produces, so exactly one restore
	 * path exists however the parent came back.
	 */
	restoreFromRegistry(nodes: readonly RegistryNode[]): ManagedAgent[] {
		const records: HibernatedRecord[] = [];
		for (const node of nodes) {
			if (!node.sessionFile || !node.sessionDir) continue; // Nothing to resume.
			records.push({
				// A cold start has no local ids to be consistent with, so the session
				// uuid doubles as one. The name is not usable here: it was only ever
				// unique inside the parent that coined it.
				id: node.agentId ?? node.sessionId,
				sessionId: node.sessionId,
				...(node.parentSessionId ? { parentSessionId: node.parentSessionId } : {}),
				name: node.name,
				// The text lives beside the child's transcript. A directory that has been
				// cleaned up leaves the label, which is enough to describe the child in a
				// listing and must never be a reason it cannot be revived.
				task: readTaskFile(node.sessionDir) ?? "",
				...(node.taskSummary ? { taskSummary: node.taskSummary } : {}),
				...(node.persona ? { persona: node.persona } : {}),
				cwd: node.cwd ?? process.cwd(),
				contextMode: node.contextMode ?? "fresh",
				...(node.model ? { model: node.model } : {}),
				status: node.status,
				// Both of auto-resume's inputs, and both were silently dropped here — which
				// meant a cold start could not resume anything at all. `Registry.live()`
				// has already rewritten `status` to `hibernated` for every node whose pid
				// is gone, so by the time a node reaches this function the *only* surviving
				// evidence that it was mid-task is `unfinishedStatus`. Losing
				// `resumeAttempts` is worse than it looks: the counter lives on the node
				// precisely so it survives the restart it is counting, and resetting it
				// here gives a crash-looping child a fresh three attempts per launch.
				...(node.unfinishedStatus ? { unfinishedStatus: node.unfinishedStatus } : {}),
				...(node.resumeAttempts ? { resumeAttempts: node.resumeAttempts } : {}),
				sessionFile: node.sessionFile,
				sessionDir: node.sessionDir,
				...(node.promptFile ? { promptFile: node.promptFile } : {}),
				startedAt: node.startedAt ?? node.lastActiveAt,
				...(node.endedAt ? { endedAt: node.endedAt } : {}),
				usage: node.usage ?? emptyUsage(),
				// Not carried across a cold start: the last assistant text is in the
				// child's own transcript, and caching a copy of it in the registry was the
				// bulk of that file's churn.
				output: "",
				...(node.error ? { error: node.error } : {}),
				launch: node.launch ?? { notesPath: "" },
			});
		}
		// The cause is the whole difference from a reload: this parent has never met
		// these children, so each one is mailed as `restored`.
		return this.restore(records, "cold-restore");
	}

	private get autoResumeMaxAgeMinutes(): number {
		const configured = this.config.autoResumeMaxAgeMinutes;
		return typeof configured === "number" && Number.isFinite(configured)
			? configured
			: DEFAULT_AUTO_RESUME_MAX_AGE_MINUTES;
	}

	private get maxResumeAttempts(): number {
		const configured = this.config.maxResumeAttempts;
		return typeof configured === "number" && Number.isFinite(configured)
			? configured
			: DEFAULT_MAX_RESUME_ATTEMPTS;
	}

	/**
	 * Restart work that nobody chose to stop.
	 *
	 * The framework's half of a promise the orchestrator kept failing to keep. An
	 * agent hibernated **mid-task** by a reload or a crash is picked up again here
	 * — revived on its existing session file and told to continue — with no human
	 * action and no orchestrator decision. An agent hibernated **after finishing**
	 * is left exactly where it is: the idle sweep stopped it on purpose and
	 * restarting it would redo completed work.
	 *
	 * Deliberately *not* a rule in `orchestrator.md`. Guidance is advice a model
	 * may decline, and this one has been declined; there is exactly one right
	 * answer here, so the framework takes it.
	 *
	 * Errors are contained per agent: one child that cannot be revived must not
	 * stop the others from coming back, and a failure to resume is itself reported
	 * through the transition table rather than swallowed.
	 */
	async autoResume(
		trigger: ResumeTrigger,
		now = Date.now(),
		/**
		 * Cancellation, honoured *between* agents as well as inside each revive.
		 *
		 * This method starts processes in a loop, so a shutdown that arrives halfway
		 * through must be able to stop it starting more — otherwise the session tears
		 * down while children are still being launched behind it.
		 */
		signal?: AbortSignal,
	): Promise<{ resumed: ManagedAgent[]; gaveUp: ManagedAgent[] }> {
		const candidates = this.list()
			// Only agents with no process: anything still running needs nothing.
			.filter((agent) => !agent.client?.running)
			.map((agent) => ({
				agent,
				name: agent.name,
				// The pre-hibernation status is the input, not the current one — which
				// says `hibernated` for finished and interrupted work alike.
				status: agent.unfinishedStatus ?? agent.status,
				lastActiveAt: lastActiveAt(reapCandidate(agent)),
				resumeAttempts: agent.resumeAttempts,
				hasSessionFile: existsSync(agent.sessionFile),
			}));
		const plan = planResumes(candidates, {
			trigger,
			now,
			autoResumeMaxAgeMinutes: this.autoResumeMaxAgeMinutes,
			maxResumeAttempts: this.maxResumeAttempts,
		});

		const gaveUp: ManagedAgent[] = [];
		for (const { candidate, reason } of plan.giveUp) {
			const agent = candidate.agent;
			agent.error = reason;
			// Published as an `error` that *steers*: the automatic recovery which would
			// otherwise have handled this is now switched off for this agent, so the
			// work is stranded until somebody intervenes. Giving up silently would be
			// the same bug this table exists to prevent, one level up.
			this.transition(agent, "failed", "resume-exhausted", reason);
			gaveUp.push(agent);
		}

		const resumed: ManagedAgent[] = [];
		for (const { candidate, attempt } of plan.resume) {
			// Checked every iteration, not just once: each revive spawns a process and
			// the caller may have given up since the previous one.
			if (signal?.aborted) break;
			const agent = candidate.agent;
			// Incremented and persisted *before* the attempt, not after. If this very
			// resume is what kills the process, an increment that happened afterwards
			// would never be written and the loop would run forever.
			agent.resumeAttempts = attempt;
			this.recordTransition(agent);
			try {
				await this.revive(agent.id, signal);
				agent.busy = true;
				agent.endedAt = undefined;
				agent.lastEventAt = Date.now();
				agent.error = undefined;
				// Cleared only once it is actually running again: if the prompt below
				// throws, the agent is still interrupted work and still resumable.
				agent.unfinishedStatus = undefined;
				this.transition(
					agent,
					"running",
					"auto-resumed",
					`"${agent.name}" was stopped mid-task by a ${
						trigger === "reload" ? "reload" : "restart of pi"
					} and has been restarted automatically (attempt ${attempt} of ` +
						`${this.maxResumeAttempts}). It is continuing the task it was given: ` +
						`${agent.task || "(task not recorded)"}`,
				);
				await agent.client!.prompt(resumePrompt(agent.name, trigger), undefined, { signal });
				resumed.push(agent);
			} catch (error) {
				// One child that will not come back must not stop the others. `revive`
				// has already put it back to `hibernated` and mailed nothing, which is
				// right: the next resume attempt will try again, and the attempt counter
				// above is what stops that being forever.
				this.pushActivity(
					agent,
					`auto-resume failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (resumed.length > 0 || gaveUp.length > 0) this.callbacks.onChange();
		return { resumed, gaveUp };
	}

	/** Snapshot every live child for `pi.appendEntry`; see hibernate.ts. */
	records(): HibernatedRecord[] {
		return this.list()
			.filter((agent) => agent.status !== "closed")
			.map(toRecord);
	}

	/**
	 * Give an agent a process again, resuming its existing session file.
	 *
	 * Used both after a reload and as the last resort for a child so wedged that
	 * it will not even answer an abort. Idempotent: an agent that already has a
	 * running client is left alone, because two `pi` processes writing one
	 * session file would interleave their entries.
	 */
	async revive(nameOrId: string, signal?: AbortSignal): Promise<ManagedAgent> {
		const agent = this.require(nameOrId);
		if (agent.status === "closed") throw new Error(`subagent "${agent.name}" is closed`);
		if (agent.client?.running) return agent;
		// A revive turns a record back into a process, so it is subject to the same
		// cap as a spawn; otherwise reviving a table's worth of hibernated children
		// after a reload quietly doubles the number of running agents.
		const holdsSlot = agent.status !== "hibernated";
		const others = this.slotsInUse - (holdsSlot ? 1 : 0);
		if (others >= this.maxOpenAgents) {
			throw new Error(
				`too many open subagents (${others}/${this.maxOpenAgents}); close one before ` +
					`resuming "${agent.name}"`,
			);
		}
		if (!existsSync(agent.sessionFile)) {
			throw new Error(
				`subagent "${agent.name}" cannot be revived: its session file is gone (${agent.sessionFile})`,
			);
		}
		// A hibernated agent does not count until it is `idle` again, several awaits
		// from here, so it holds a reservation until then — the same gap, and the
		// same fix, as in `spawn`. One that already counts needs none.
		const release = holdsSlot ? () => {} : this.reserveSlot();
		try {
			return await this.reviveReserved(agent, signal);
		} finally {
			release();
		}
	}

	/** The body of `revive`, once the cap has been checked and a slot reserved. */
	private async reviveReserved(agent: ManagedAgent, signal?: AbortSignal): Promise<ManagedAgent> {
		// Detached *before* it is stopped: `handleExit` ignores any client that is
		// no longer the agent's, so the death we are about to cause is not reported
		// as a crash of the agent we are reviving.
		const previous = agent.client;
		agent.client = undefined;
		// Bounded: the process we are replacing may be exactly the wedged one that
		// made a revive necessary, and it must not get to block its own replacement.
		await bestEffort(previous?.stop(1000), 3_000, `stopping the old process of "${agent.name}"`);

		const trustExtensions = await this.refreshChildExtensions(agent, signal);

		const client = this.createClient({
			name: agent.name,
			cwd: agent.cwd,
			sessionFile: agent.sessionFile,
			sessionDir: agent.sessionDir,
			promptFile: agent.promptFile,
			launch: agent.launch,
			trustExtensions,
			parentSessionId: agent.parentSessionId ?? this.config.parentSessionId,
		});
		agent.client = client;
		agent.abortRequested = false;
		// The old process is gone, and with it whatever it was blocked on.
		agent.pendingQuestion = undefined;
		this.attach(agent, client);
		try {
			await client.start(signal);
		} catch (error) {
			let detail = error instanceof Error ? error.message : String(error);
			const stderr = client.getStderr().trim();
			if (stderr) detail += `\nstderr: ${stderr.slice(-2000)}`;
			await bestEffort(client.stop(1000), 3_000, `stopping the failed revive of "${agent.name}"`);
			if (agent.client === client) agent.client = undefined;
			// Kept in the list: the transcript is still readable and worth another try
			// once whatever broke (credentials, network) is fixed.
			agent.busy = false;
			this.transition(agent, "hibernated", "revive-failed");
			this.callbacks.onChange();
			throw new Error(`failed to revive subagent "${agent.name}": ${detail}`);
		}
		agent.busy = false;
		agent.lastEventAt = Date.now();
		// New pid, so the registry's liveness answer changes here.
		this.transition(agent, "idle", "revived");
		this.callbacks.onChange();
		return agent;
	}

	/**
	 * Change which MCP servers a child boots, after it has been spawned.
	 *
	 * **This does not hot-swap.** MCP servers are connected while the child's
	 * process starts up, from an environment variable that process was launched
	 * with, so there is no honest way to widen or narrow a *running* child from
	 * out here. What this does is rewrite the launch spec, which is what the next
	 * `createClient` reads — so the change lands on the child's next revive.
	 *
	 * That is less theoretical than it sounds: children hibernate on idle and
	 * revive on the next message, so "next revive" is usually "next thing you say
	 * to it". The caller is told the deferral explicitly rather than left to
	 * assume otherwise; see the tool's message in index.ts.
	 *
	 * The alternative — a new RPC that asks the child's mcp extension to reconnect
	 * — was rejected on purpose. `ChildRpc` is a deliberately small protocol (it
	 * does not even implement `extension_ui_request`, which is why dialog-opening
	 * extensions hang a child), and inventing a second, extension-specific channel
	 * to save one revive would be a fragile path used a handful of times a day.
	 *
	 * Returns whether the child must be revived for the change to take effect, so
	 * the caller can say the right thing rather than guess.
	 */
	setMcpScope(nameOrId: string, servers: readonly string[]): { agent: ManagedAgent; pending: boolean } {
		const agent = this.require(nameOrId);
		if (agent.status === "closed") throw new Error(`subagent "${agent.name}" is closed`);
		const scope = parseMcpScope([...servers]) ?? [];
		agent.launch = { ...agent.launch, mcpScope: scope };
		// Persisted immediately: the whole value of a deferred change is that it
		// survives until the revive that applies it, including across a parent
		// reload, and the registry is the only thing that spans that.
		this.recordTransition(agent);
		this.callbacks.onChange();
		// A child with no process has nothing to contradict the new scope; one with a
		// live process is still running under the old one until it is restarted.
		return { agent, pending: Boolean(agent.client?.running) };
	}

	// --------------------------------------------------------------- stalls --

	private get stallSeconds(): number {
		const configured = this.config.stallSeconds;
		return typeof configured === "number" && Number.isFinite(configured)
			? configured
			: DEFAULT_STALL_SECONDS;
	}

	/**
	 * Reclassify every child against the clock.
	 *
	 * Called from a timer in index.ts rather than from the event stream, because
	 * the whole point is to notice the *absence* of events.
	 */
	sweepStalls(now = Date.now()): void {
		let changed = false;
		for (const agent of this.list()) {
			const transition = stallTransition({
				busy: agent.busy,
				status: agent.status,
				lastEventAt: agent.lastEventAt,
				now,
				stallSeconds: this.stallSeconds,
				awaitingAnswer: Boolean(agent.pendingQuestion),
			});
			if (!transition) continue;
			changed = true;
			if (transition === "stalled") {
				const silent = now - (agent.lastEventAt ?? now);
				const first = !agent.stallNotifiedAt;
				if (first) {
					agent.stallNotifiedAt = now;
					// The widget shows the last activity line; without this it keeps
					// showing the tool call from before the connection went away.
					this.pushActivity(agent, `no activity for ${describeSilence(silent)}`);
				}
				// The mail decision is the table's, not this loop's — the whole reason
				// transitions.ts exists is that this branch once told the human and not
				// the orchestrator. The status is set either way; only the *first* sweep
				// that sees the stall carries content, so a re-sweep does not re-mail.
				this.transition(
					agent,
					"stalled",
					first ? "silent" : "still-silent",
					`"${agent.name}" has produced no events for ${describeSilence(silent)}. ` +
						"It may have lost its connection, wedged, or be blocked on a dialog it " +
						`cannot display. Read it, then retry it with subagent{action:"retry",name:"${agent.name}"} ` +
						"— retry resumes its existing conversation and loses nothing.",
				);
				if (first) {
					try {
						this.callbacks.onStall?.(agent, silent);
					} catch {
						/* a failed notification must not stop the sweep */
					}
				}
			} else {
				// Events came back on their own: nothing was broken after all.
				agent.stallNotifiedAt = undefined;
				this.transition(agent, "running", "recovered");
			}
		}
		if (changed) this.callbacks.onChange();
	}

	// ----------------------------------------------------------- idle reaping --

	private get idleHibernateMinutes(): number {
		const configured = this.config.idleHibernateMinutes;
		return typeof configured === "number" && Number.isFinite(configured)
			? configured
			: DEFAULT_IDLE_HIBERNATE_MINUTES;
	}

	/**
	 * Put completed children that nobody has touched to sleep.
	 *
	 * The same mechanism as reload hibernation, on a timer instead of a shutdown:
	 * the process stops, the record and the conversation stay, and a `followup`
	 * revives it. That is what keeps a finished agent from holding a process (and
	 * a slot) indefinitely just because the orchestrator forgot about it — while
	 * still keeping its work reachable, which a close would not.
	 */
	async sweepIdle(now = Date.now()): Promise<ManagedAgent[]> {
		const due = selectIdleHibernations(
			this.list().map(reapCandidate),
			now,
			this.idleHibernateMinutes,
		);
		const slept: ManagedAgent[] = [];
		for (const candidate of due) {
			const agent = this.get(candidate.id);
			if (!agent) continue;
			// `"idle-sweep"` is the cause that makes this mail the orchestrator: it had
			// been asked to decide this child's fate and chose to keep it, and the
			// system has now overridden that. Before the table this was the one reap
			// the orchestrator was never told about.
			await this.hibernate(agent, 1500, "idle-sweep");
			slept.push(agent);
			try {
				this.callbacks.onReap?.(agent, "idle");
			} catch {
				/* the footer already shows it as hibernated */
			}
		}
		if (slept.length > 0) this.callbacks.onChange();
		return slept;
	}

	/**
	 * Stop one child's process while keeping everything that makes it revivable.
	 *
	 * Shared by the idle sweep and `hibernateAll`, so "hibernated" means exactly
	 * one thing however it happened — but the *cause* differs, and that is the
	 * whole reason the orchestrator hears about one and not the other.
	 */
	private async hibernate(
		agent: ManagedAgent,
		timeoutMs = 1500,
		cause: TransitionCause = "shutdown",
	): Promise<void> {
		// Not "closed": that status means the human ended it, and it is what the
		// exit handler and the session-dir cleanup key off.
		const next: AgentStatus = agent.status === "failed" ? "failed" : "hibernated";
		const idled = agent.output.trim();
		// Recorded *before* the status is overwritten, because "hibernated" is true of
		// a finished child and an interrupted one alike and this is the only moment
		// the difference still exists. Auto-resume restarts the second and must not
		// restart the first. Only ever set, never cleared here: an agent interrupted
		// twice keeps its original evidence of having been mid-task.
		if (isUnfinished(agent.status)) agent.unfinishedStatus = agent.status;
		agent.busy = false;
		agent.stallNotifiedAt = undefined;
		// A hibernated child is not blocked on us: its process is gone and its
		// `ask_parent` poll loop with it. Leaving the question set would keep the
		// footer demanding an answer that could never be read.
		agent.pendingQuestion = undefined;
		const client = agent.client;
		agent.client = undefined; // Silences the exit handler for a death we asked for.
		// Written (via `transition`) *before* the stop: if the kill hangs and this
		// process is killed with it, the registry already says the node has no
		// process, which is the conservative answer and the one a cold start can act
		// on. The mail decision is taken here for the same reason — a stop that hangs
		// must not also swallow the notice.
		this.transition(
			agent,
			next,
			cause,
			`"${agent.name}" finished a while ago and nobody followed it up, so its process ` +
				`was stopped after ${this.idleHibernateMinutes} idle minutes. You had kept it; ` +
				"the system put it to sleep anyway." +
				(idled ? `\n\nIts last result was:\n${idled}` : ""),
		);
		await bestEffort(
			client?.stop(Math.max(200, Math.floor(timeoutMs / 2))),
			timeoutMs,
			`hibernating "${agent.name}"`,
		);
	}

	// ------------------------------------------------------------ questions --

	/**
	 * Answer the question a child is blocked on.
	 *
	 * Written atomically (tmp + rename) because the child is polling the file: a
	 * partial read must be impossible, not merely unlikely. Deliberately a file
	 * rather than an RPC message, so an answer still lands if the parent reloaded
	 * and revived the child in between.
	 *
	 * Note what this method does **not** do: it never waits for the child to pick
	 * the answer up, or to resume, or to say anything at all. `ask_parent` has no
	 * timeout *on the child side* — the child blocks until answered, deliberately
	 * — and the way that stays safe is that the parent's half of the protocol is
	 * only ever "write a file" and "publish mail". A blocked child therefore
	 * cannot wedge the parent no matter how long it blocks. Nothing in the parent
	 * may ever await a child's answer; if it did, two agents would be waiting on
	 * each other with no timeout on either side.
	 */
	async answer(nameOrId: string, message: string): Promise<{ agent: ManagedAgent; delivered: boolean }> {
		const agent = this.require(nameOrId);
		const text = String(message ?? "").trim();
		if (!text) throw new Error("answer requires a message");
		const pending = agent.pendingQuestion;
		if (!pending) return { agent, delivered: false };

		const directory = answersDirectory(agent.sessionDir);
		const target = answerPath(directory, pending.id);
		const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
		// Bounded because the answers directory can live on a network filesystem,
		// where an fs call is not the instant operation it looks like.
		await bounded(
			(async () => {
				await mkdir(directory, { recursive: true, mode: 0o700 });
				await writeFile(
					temporary,
					JSON.stringify({
						questionId: pending.id,
						answer: text,
						answeredAt: Date.now(),
						answeredBy: "parent",
					}),
					{ encoding: "utf-8", mode: 0o600 },
				);
				// Atomic within a filesystem: the child sees no file, then the whole file.
				await rename(temporary, target);
			})(),
			ANSWER_WRITE_TIMEOUT_MS,
			undefined,
			`writing the answer for "${agent.name}"`,
		);

		// Optimistic: the child clears this itself on `tool_execution_end`, but the
		// UI should stop saying "waiting for you" the moment we have answered.
		agent.pendingQuestion = undefined;
		if (agent.status === "waiting") this.transition(agent, "running", "answered");
		agent.lastEventAt = Date.now();
		this.mailbox.drain(agent.id);
		this.callbacks.onChange();
		return { agent, delivered: true };
	}

	/** Every child currently blocked on a question. */
	pendingQuestions(): Array<{ agent: ManagedAgent; question: PendingQuestion }> {
		return this.list()
			.filter((agent) => agent.pendingQuestion)
			.map((agent) => ({ agent, question: agent.pendingQuestion! }));
	}

	/** Milliseconds since this child last said anything, if it ever has. */
	silentFor(agent: ManagedAgent, now = Date.now()): number | undefined {
		return agent.lastEventAt === undefined ? undefined : Math.max(0, now - agent.lastEventAt);
	}

	/**
	 * Recover a stalled (or dead) child without losing its conversation.
	 *
	 * First an abort, which is enough when the provider call is merely hung: the
	 * child settles and can be prompted again. If the process will not answer
	 * that, it is replaced the same way hibernation replaces one — a new `pi`
	 * on the same session file — and re-prompted there.
	 */
	async retry(
		nameOrId: string,
		message?: string,
		options: RequestOptions = {},
	): Promise<{ agent: ManagedAgent; revived: boolean }> {
		const agent = this.require(nameOrId);
		if (agent.status === "closed") throw new Error(`subagent "${agent.name}" is closed`);
		const prompt = (message ?? "").trim() || this.retryPrompt(agent);

		let revived = false;
		if (needsRevive(agent)) {
			await this.revive(agent.id, options.signal);
			revived = true;
		} else {
			// The abort's own settle must not be mailed to the parent as a result.
			agent.abortRequested = true;
			try {
				// Here — unlike `interrupt` — the acknowledgement is worth waiting for,
				// because its absence is the signal to escalate to replacing the process.
				// It is bounded (and cancellable) by `ChildRpc.send` itself; 5s is well
				// inside that ceiling and keeps the escalation snappy.
				await agent.client!.abort({ ...options, timeoutMs: 5_000 });
			} catch (error) {
				// The caller pressing Escape is not a wedged child: do not respond to it
				// by restarting a process nobody is waiting for any more.
				if (options.signal?.aborted) throw error;
				// Wedged beyond an abort: replace the process instead.
				agent.abortRequested = false;
				await this.revive(agent.id, options.signal);
				revived = true;
			}
		}

		agent.abortRequested = false;
		agent.busy = true;
		agent.error = undefined;
		agent.endedAt = undefined;
		agent.stallNotifiedAt = undefined;
		agent.lastEventAt = Date.now();
		agent.pendingQuestion = undefined;
		this.transition(agent, "running", "resumed");
		await agent.client!.prompt(prompt, undefined, options);
		this.callbacks.onChange();
		return { agent, revived };
	}

	private retryPrompt(agent: ManagedAgent): string {
		return (
			"Your previous request did not complete (the connection to the model provider " +
			"appears to have failed). Nothing you did before that is lost. Continue from where " +
			`you were on your task:\n\n${agent.task}`
		);
	}

	private resolveCwd(parentCwd: string, requested: string): string {
		const resolved = requested.startsWith("/") ? requested : join(parentCwd, requested);
		if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
			throw new Error(
				`working directory does not exist: ${resolved}. Create the worktree before spawning.`,
			);
		}
		return resolved;
	}

	private parentModel(ctx: any): string | undefined {
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	}

	private buildSystemPrompt(
		name: string,
		_task: string,
		cwd: string,
		notesPath: string,
		persona?: Persona,
	): string {
		const sections: string[] = [];
		if (persona?.systemPrompt.trim()) sections.push(persona.systemPrompt.trim());
		sections.push(
			[
				"# Subagent protocol",
				"",
				`You are "${name}", a delegated agent working for a parent agent. You own one task and`,
				"you run to completion without asking the parent for permission to continue.",
				"",
				`Your working directory is ${cwd}. Sibling agents may be working in other directories, so`,
				"stay inside your own tree unless your task explicitly sends you elsewhere.",
				"",
				"Coordination:",
				`- Shared mission notes live at ${notesPath}. Read them before you start (shared_notes read).`,
				"- Append decisions, interfaces and constraints that siblings must honor (shared_notes append).",
				"- Use report_to_parent only for findings the parent needs before you are done.",
				"- Your final response is delivered to the parent automatically. Make it a self-contained",
				"  summary: what changed, where, what was verified, and what remains.",
			].join("\n"),
		);
		return sections.join("\n\n");
	}

	private firstPrompt(name: string, task: string, mode: string): string {
		const preamble =
			mode === "fresh"
				? "You have no context from the parent conversation beyond this task."
				: mode === "compacted"
					? "Context inherited from the parent conversation is summarized above."
					: "The conversation above is inherited from the parent agent; it is background, not instructions to re-execute.";
		return `${preamble}\n\nYou are "${name}". Your task:\n\n${task}`;
	}

	/**
	 * Observe a child's raw RPC event stream.
	 *
	 * This is a read-only seam for the UI: the chat pane renders the same events
	 * pi's interactive mode renders for the main agent. Listeners never affect
	 * lifecycle, and a throwing listener is ignored.
	 */
	onAgentEvent(agentId: string, listener: (event: RpcEvent) => void): () => void {
		let listeners = this.eventListeners.get(agentId);
		if (!listeners) {
			listeners = new Set();
			this.eventListeners.set(agentId, listeners);
		}
		listeners.add(listener);
		return () => {
			const current = this.eventListeners.get(agentId);
			current?.delete(listener);
			if (current && current.size === 0) this.eventListeners.delete(agentId);
		};
	}

	private attach(agent: ManagedAgent, client: ChildRpc): void {
		client.onExit((exit: RpcExit) => {
			// A client that has already been replaced (revive) is history; its death
			// says nothing about the process the agent is running on now.
			if (agent.client !== client) return;
			try {
				this.handleExit(agent, exit);
			} catch {
				// Never let bookkeeping for a dead child throw into the event loop.
			}
		});
		client.onEvent((event: RpcEvent) => {
			if (agent.client !== client) return;
			// Before the handler: liveness is about *any* traffic, including events
			// this manager does not otherwise care about.
			agent.lastEventAt = Date.now();
			if (agent.status === "stalled") {
				// The child is talking again; a stall is never sticky.
				agent.stallNotifiedAt = undefined;
				this.transition(agent, "running", "recovered");
			}
			try {
				this.handleEvent(agent, event);
			} catch {
				// Never let a malformed child event break the parent.
			}
			for (const listener of this.eventListeners.get(agent.id) ?? []) {
				try {
					listener(event);
				} catch {
					// A broken observer must not disturb the child.
				}
			}
		});
	}

	/**
	 * The child process died on its own (crash, OOM, external kill).
	 *
	 * Nothing else observes this: without it the agent stays busy forever and no
	 * mail is ever published, so the death is never reported to the parent.
	 */
	private handleExit(agent: ManagedAgent, exit: RpcExit): void {
		// A dead child is not waiting for an answer: its `ask_parent` poll loop died
		// with it. Left set, the question would be offered forever — the footer
		// would say "1 waiting for you", and `answer()` would happily write a file
		// no process will ever read and report `delivered: true`. Cleared before the
		// early return so it also covers a child we killed ourselves.
		const wasWaiting = agent.status === "waiting";
		agent.pendingQuestion = undefined;
		if (agent.status === "closed") return; // We asked for this one.
		// A child that had already finished its turn (or already failed, or was
		// interrupted) has been reported once; its later exit is not news. A child
		// that died mid-question was never reported, so it is not "already settled"
		// however un-busy it looks.
		const alreadySettled =
			!wasWaiting &&
			!agent.busy &&
			(agent.status === "completed" || agent.status === "interrupted" || agent.status === "failed");
		agent.busy = false;
		agent.endedAt ??= Date.now();
		if (alreadySettled) {
			this.recordTransition(agent);
			this.callbacks.onChange();
			return;
		}

		const stderr = agent.client?.getStderr().trim() ?? "";
		const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? "unknown"}`;
		agent.error =
			`subagent process died (${how})` + (stderr ? `\nstderr: ${stderr.slice(-2000)}` : "");
		// `"abort-requested"` is the S4 silence: the parent asked for this death, and
		// reporting it as an error is reporting the parent's own action back at it.
		this.transition(
			agent,
			"failed",
			agent.abortRequested ? "abort-requested" : "died",
			agent.error,
		);
		agent.abortRequested = false;
		this.callbacks.onChange();
	}

	private pushActivity(agent: ManagedAgent, text: string): void {
		agent.activity.push({ at: Date.now(), text });
		if (agent.activity.length > LIMITS.maxActivityLines) {
			agent.activity.splice(0, agent.activity.length - LIMITS.maxActivityLines);
		}
		this.callbacks.onChange();
	}

	private handleEvent(agent: ManagedAgent, event: RpcEvent): void {
		switch (event.type) {
			case "tool_execution_start": {
				this.pushActivity(agent, describeToolCall(event.toolName, event.args));
				break;
			}
			case "tool_execution_update": {
				// The only event that reaches us *during* a tool call, which is what
				// makes a blocking question possible at all (see ask.ts).
				const question = questionFromUpdate(event);
				if (!question) break;
				if (agent.pendingQuestion?.id === question.id) break; // Re-announcement.
				agent.pendingQuestion = question;
				// It is blocked on us, not broken: clear any stall the silence earned.
				agent.stallNotifiedAt = undefined;
				this.pushActivity(agent, `asked: ${question.question.slice(0, 70)}`);
				// Published unconditionally, and *before* anything looks at whether the
				// parent is idle: enqueueing a question is a guarantee, delivering it
				// promptly is only an optimisation. A question that were dropped here
				// would block its child forever, since `ask_parent` has no timeout.
				this.transition(
					agent,
					"waiting",
					"asked",
					question.context
						? `${question.question}\n\nWhat it has already tried:\n${question.context}`
						: question.question,
					{ questionId: question.id },
				);
				this.callbacks.onChange();
				break;
			}
			case "tool_execution_end": {
				if (event.toolName === "ask_parent") {
					// Answered (or aborted): it is working again either way.
					agent.pendingQuestion = undefined;
					if (agent.status === "waiting") this.transition(agent, "running", "answered");
					agent.lastEventAt = Date.now();
					this.callbacks.onChange();
					break;
				}
				if (event.toolName !== "report_to_parent") break;
				const summary = event.result?.details?.summary;
				if (typeof summary === "string" && summary.trim()) {
					this.mailbox.publish({
						kind: "report",
						agentId: agent.id,
						agentName: agent.name,
						content: summary.trim(),
					});
					this.callbacks.onMail(agent.name, "report");
				}
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message?.role !== "assistant") break;
				agent.usage.turns += 1;
				const usage = message.usage;
				if (usage) {
					agent.usage.input += usage.input ?? 0;
					agent.usage.output += usage.output ?? 0;
					agent.usage.cacheRead += usage.cacheRead ?? 0;
					agent.usage.cacheWrite += usage.cacheWrite ?? 0;
					agent.usage.cost += usage.cost?.total ?? 0;
					agent.usage.contextTokens = usage.totalTokens ?? agent.usage.contextTokens;
				}
				if (!agent.model && message.model) agent.model = message.model;

				const text = Array.isArray(message.content)
					? message.content
							.filter((part: any) => part?.type === "text")
							.map((part: any) => part.text)
							.join("\n")
							.trim()
					: "";
				if (text) agent.output = text;
				if (message.errorMessage) {
					agent.error = message.errorMessage;
					// Silent here by the table: the `agent_settled` that follows carries the
					// same message as `error` mail, and mailing both says it twice.
					this.transition(agent, "failed", "child-error");
				}
				break;
			}
			case "agent_settled": {
				agent.busy = false;
				if (agent.abortRequested) {
					// This settle is the answer to our own abort. The parent already knows
					// it stopped this child; delivering "final"/"error" mail here would
					// report the abort as if it were the child's result.
					agent.abortRequested = false;
					agent.endedAt = Date.now();
					this.transition(agent, "interrupted", "abort-requested");
					this.callbacks.onChange();
					break;
				}
				// Whatever the turn ended as, this is where it is reported. `closed` and
				// `interrupted` stay where they are (and the table keeps both silent);
				// `failed` was set by `message_end` and is reported here rather than there.
				const settledAs: AgentStatus =
					agent.status === "failed" || agent.status === "closed" || agent.status === "interrupted"
						? agent.status
						: "completed";
				if (settledAs === "completed") agent.endedAt = Date.now();
				const content =
					settledAs === "failed"
						? (agent.error ?? "subagent failed without a message")
						: agent.output || "(the subagent finished without producing text)";
				// A settle is also the transition most worth having on disk: it carries the
				// result and the final usage, and it is what a cold start reports.
				this.transition(agent, settledAs, "settled", content);
				this.callbacks.onChange();
				break;
			}
		}
	}

	/**
	 * Queue more work for a child. Resumes a finished child in place.
	 *
	 * A hibernated child (or one whose process died) is revived first, on its own
	 * session file, so "talk to it again" is the same gesture whether or not the
	 * parent has reloaded since.
	 */
	async send(
		nameOrId: string,
		message: string,
		mode: "steer" | "followUp",
		options: RequestOptions = {},
	): Promise<ManagedAgent> {
		const agent = this.require(nameOrId);
		if (agent.status === "closed") throw new Error(`subagent "${agent.name}" is closed`);
		if (needsRevive(agent)) await this.revive(agent.id, options.signal);

		if (agent.busy) {
			if (mode === "steer") await agent.client!.steer(message, options);
			else await agent.client!.followUp(message, options);
		} else {
			agent.busy = true;
			agent.endedAt = undefined;
			agent.lastEventAt = Date.now();
			agent.stallNotifiedAt = undefined;
			// A new turn is not the old turn's failure: leaving `error` set makes the
			// next settle re-publish the stale error instead of the new result.
			agent.error = undefined;
			agent.abortRequested = false;
			this.transition(agent, "running", "resumed");
			await agent.client!.prompt(message, undefined, options);
		}
		this.recordTransition(agent);
		this.callbacks.onChange();
		return agent;
	}

	/**
	 * Stop a child's current turn, keeping its conversation.
	 *
	 * This is the method that froze a whole pi session, and the shape of the fix
	 * is the general lesson. Two things were wrong:
	 *
	 *   1. It awaited `abort()`, whose response promise had neither a deadline nor
	 *      a cancellation path. A child that accepted the command and never
	 *      answered left the parent's turn permanently unfinishable — Escape and
	 *      `/reload` both queue behind it, so there was no way out at all.
	 *   2. Even a *prompt* response would not have meant what the await implied:
	 *      an RPC acknowledgement says the abort was **accepted**, not that the
	 *      child stopped. The actual stop arrives later as `agent_settled`, which
	 *      the event handler already deals with.
	 *
	 * So the acknowledgement is not awaited at all. The local state — the part
	 * the parent owns, and the only part the caller can observe — is updated
	 * synchronously, and the abort is dispatched as a bounded, cancellable
	 * request whose failure is recorded rather than propagated. The result is
	 * that `interrupt()` returns in constant time whatever the child does, which
	 * is the only acceptable behaviour for the button labelled "stop".
	 */
	interrupt(nameOrId: string, options: RequestOptions = {}): ManagedAgent {
		const agent = this.require(nameOrId);
		// Set before the abort is dispatched: the child's settle event can arrive
		// before this method has even returned.
		if (agent.busy || agent.status === "running" || agent.status === "starting") {
			agent.abortRequested = true;
		}
		const client = agent.client;
		if (client?.running) {
			// Fire-and-forget, but not fire-and-forget-about: a child that will not
			// even acknowledge an abort is wedged, and `retry` is the way out. The
			// note is attached to the agent rather than thrown, because the interrupt
			// itself did succeed as far as the parent is concerned.
			void client.abort(options).catch((error: unknown) => {
				if (agent.client !== client) return; // Replaced since; not news.
				const detail = error instanceof Error ? error.message : String(error);
				this.pushActivity(agent, `abort not acknowledged: ${detail}`);
			});
		}
		// A child blocked in `ask_parent` is interrupted too: its poll loop honours
		// the abort signal, but the question must stop being offered to the parent
		// either way, or the UI keeps asking for an answer nobody is waiting for.
		agent.pendingQuestion = undefined;
		agent.busy = false;
		agent.stallNotifiedAt = undefined;
		agent.endedAt = Date.now();
		// Deliberately silent (S4). The parent asked for this stop and the tool call
		// it asked through returns the outcome; mailing an `error` here reported the
		// parent's own action back to it as a spurious failure.
		this.transition(agent, "interrupted", "abort-requested");
		this.callbacks.onChange();
		return agent;
	}

	async close(nameOrId: string, timeoutMs = 3_000): Promise<ManagedAgent> {
		const agent = this.require(nameOrId);
		// Decided before we overwrite the status: a failed child's session file is
		// the only post-mortem evidence there is, so it survives the close.
		const keepForPostMortem = agent.status === "failed" || Boolean(agent.error);
		// Marked closed *before* the kill so the exit handler knows this death was
		// requested and does not mail the parent an error about it. Silent by the
		// table: the `close` tool call returns the outcome, and this agent's mailbox
		// is drained a few lines below anyway.
		this.transition(agent, "closed", "closed");
		// A hibernated agent has no process, but everything else about closing it —
		// draining its mail, freeing its slot, deleting its session dir — applies.
		//
		// Bounded: `stop()` already races its own SIGKILL, but a child in an
		// unkillable state (uninterruptible disk sleep, a lost exit event) must not
		// be able to hold the tool call open. The kill is already in flight; the
		// bookkeeping below does not need to watch it land.
		await bestEffort(agent.client?.stop(timeoutMs), timeoutMs * 2 + 1_000, `closing "${agent.name}"`);
		agent.busy = false;
		agent.abortRequested = false;
		agent.pendingQuestion = undefined;
		agent.endedAt ??= Date.now();
		this.mailbox.drain(agent.id);
		this.agents.delete(agent.id);
		this.eventListeners.delete(agent.id);
		if (!keepForPostMortem) await this.removeSessionDir(agent);
		// A close is final: the node and everything under it leave the registry, so
		// a cold start does not offer to restore a conversation somebody ended.
		this.forgetInRegistry(agent);
		this.callbacks.onChange();
		return agent;
	}

	/** Child session dirs accumulate forever otherwise; one per spawn, unbounded. */
	private async removeSessionDir(agent: ManagedAgent): Promise<void> {
		const root = join(subagentsRoot(), "sessions");
		// Paranoia: only ever delete inside our own tree.
		if (!agent.sessionDir.startsWith(`${root}/`)) return;
		// Bounded: a large or slow tree is not a reason a `close` cannot return, and
		// an abandoned directory is a far cheaper failure than a wedged session.
		await bestEffort(
			rm(agent.sessionDir, { recursive: true, force: true }),
			SEED_TIMEOUT_MS,
			`removing the session directory of "${agent.name}"`,
		);
	}

	/**
	 * Stop every child.
	 *
	 * `timeoutMs` bounds the whole sweep, not each child: session shutdown awaits
	 * this, and a reload that visibly hangs for seconds per child is the reason
	 * people stopped pressing `/reload`. Children are stopped concurrently and a
	 * straggler is left to its own SIGKILL rather than blocking the teardown.
	 */
	async stopAll(timeoutMs = 1500): Promise<void> {
		// Recorded *before* the statuses are overwritten with "closed": quitting pi
		// stops the processes, but the conversations are still on disk and the next
		// cold start should be able to offer them back. Discarding them here was the
		// reason `kill pi` stranded a whole tree.
		this.checkpoint();
		const stops = this.list().map(async (agent) => {
			// Before the kill: this exit is not a failure. Silent by the table — the
			// whole session is going away, so there is nobody left to tell.
			this.transition(agent, "closed", "shutdown");
			agent.pendingQuestion = undefined;
			await bestEffort(
				agent.client?.stop(Math.max(200, Math.floor(timeoutMs / 2))),
				timeoutMs,
				`stopping "${agent.name}"`,
			);
		});
		// The whole sweep is bounded, not each child: session shutdown awaits this,
		// and the kills are already in flight whether or not we watch them land.
		await bestEffort(
			stops.length > 0 ? Promise.all(stops) : undefined,
			timeoutMs,
			"stopping every subagent",
		);
		this.agents.clear();
		this.mailbox.clear();
		this.callbacks.onChange();
	}

	/**
	 * Persist every child, then stop the processes without forgetting them.
	 *
	 * The records are handed back so the caller can write them into the parent's
	 * session (`pi.appendEntry`) — this class deliberately knows nothing about
	 * the parent's session file.
	 */
	async hibernateAll(timeoutMs = 1500): Promise<HibernatedRecord[]> {
		// Taken *before* anything is stopped: these records are what the caller
		// writes into the parent's session, and they must exist even if every stop
		// below hangs and we abandon it.
		const records = this.records();
		const stops = this.list().map((agent) => this.hibernate(agent, timeoutMs));
		await bestEffort(
			stops.length > 0 ? Promise.all(stops) : undefined,
			timeoutMs,
			"hibernating every subagent",
		);
		this.callbacks.onChange();
		return records;
	}

	statusIcon(status: AgentStatus): string {
		switch (status) {
			case "starting":
			case "running":
				return "◐";
			case "stalled":
				return "⚠";
			case "waiting":
				// Distinct from the stall glyph on purpose: this one is our fault.
				return "❓";
			case "completed":
				return "✓";
			case "failed":
				return "✗";
			case "interrupted":
				return "⊘";
			case "hibernated":
				return "☽";
			case "idle":
				return "·";
			default:
				return "•";
		}
	}
}

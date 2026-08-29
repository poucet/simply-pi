/**
 * The agent tree, on disk, outside any session.
 *
 * `hibernate.ts` persists children into the *parent's session file*, which
 * covers `/reload`, `/resume`, `/new` and `/fork` — every case where the same
 * session is reopened. It does not cover the one people actually do: `kill pi`,
 * then start it again. A cold start opens a brand new session and never looks at
 * the old one, so an entire tree of running children is stranded, invisible and
 * unreachable, with their session files sitting on disk.
 *
 * This module is the answer. One file, `~/.pi/agent/subagents/registry.json`,
 * next to the `sessions/<uuid>/<child>/` directories it describes:
 *
 *   - **Keyed by session uuid**, not by display name. Names are chosen by the
 *     spawning model and are unique only inside one parent, so two parents can
 *     each have a `reviewer`. A uuid is unique across the whole tree, forever.
 *   - **Parentage is a field** (`parentSessionId`), not a nesting level and not
 *     a directory layout. Arbitrary depth therefore costs nothing: a grandchild
 *     is a node whose parent happens to be a node.
 *   - **Written on every lifecycle transition** — spawn, settle, hibernate,
 *     close — not only at shutdown. A `kill -9` cannot run a shutdown hook, so
 *     anything written only at shutdown is exactly the thing that is missing
 *     when you need it. The cost is a small synchronous write per transition;
 *     the benefit is that the worst case is a slightly stale registry rather
 *     than no registry.
 *   - **Atomic** (write a temp file, `rename` over the target) and **tolerant**:
 *     a corrupt, truncated or foreign file is treated as an empty registry and
 *     replaced on the next write. A registry must never be able to stop pi from
 *     starting; the feature it powers is a convenience, and startup is not.
 *
 * Liveness is decided by pid, not by status: a node whose recorded pid is no
 * longer alive is hibernated, whatever the file claims. That is what makes a
 * crashed parent's registry safe to read — the statuses in it are frozen at the
 * moment of the crash and every one of them is a lie about a dead process.
 *
 * Nothing here starts a process. A cold start adopts the *records* of the tree
 * it left behind in this directory (see {@link autoRestorable}) — cheap, and
 * reversible with `close` — while turning any of them back into a running `pi`
 * is a separate decision made in `resume.ts`, under an age bound and a retry
 * cap. Silently spawning processes at startup is still not a thing a tool
 * should do.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { subagentsRoot } from "./context.ts";
import type { AgentUsage, LaunchSpec } from "./types.ts";
import { emptyUsage } from "./types.ts";

export const REGISTRY_VERSION = 1;

/** Where the registry lives: one file per agent directory, beside `sessions/`. */
export function registryPath(root = subagentsRoot()): string {
	return join(root, "registry.json");
}

/**
 * One agent in the tree — a root or a child, told apart only by whether it has
 * a `parentSessionId`.
 *
 * Deliberately flat JSON: it is read back by a different process, quite possibly
 * running a different version of this extension, and every field has to survive
 * that.
 */
export interface RegistryNode {
	/** The child's own session uuid. The key. */
	sessionId: string;
	/** The session uuid of whoever spawned it; absent for a root. */
	parentSessionId?: string;
	/** Display label. Not unique across the tree, and never used as a key. */
	name: string;
	/**
	 * A one-line label for the task, for listings.
	 *
	 * The task text itself lives in `task.md` in the child's session directory —
	 * see `task-store.ts` for why it is not in this file. This is deliberately
	 * lossy and deliberately *not* a truncation of the task: real tasks share long
	 * boilerplate openings, so a prefix makes a fleet of children look identical.
	 */
	taskSummary?: string;
	cwd?: string;
	/**
	 * The working directory of the session that spawned this node.
	 *
	 * Not the same as `cwd`, and the difference is the whole point: the
	 * delegate-worktree flow gives every child a worktree of its own, so a child's
	 * own `cwd` says nothing about which project it belongs to. This does, and it
	 * is what scopes auto-restore to the project you actually opened — the
	 * registry is one file for the whole machine.
	 *
	 * Optional because nodes written by earlier versions do not have it; see
	 * {@link treeSpawnedIn} for how their absence is handled.
	 */
	parentCwd?: string;
	model?: string;
	persona?: string;
	contextMode?: string;
	/** The child's session file, which is what a revive resumes. */
	sessionFile?: string;
	/** The child's session directory (transcript, prompt, answers). */
	sessionDir?: string;
	promptFile?: string;
	/** The agent id used inside the parent's manager, for continuity across a reload. */
	agentId?: string;
	status: string;
	/**
	 * What the child was doing when its process went away.
	 *
	 * The registry is where this has to live for a *cold* start: the parent's
	 * session file is gone, so the only record that it was mid-task is here. See
	 * `resume.ts` for why the distinction matters.
	 */
	unfinishedStatus?: string;
	/**
	 * How many times auto-resume has restarted this child.
	 *
	 * On the node rather than in memory precisely so it survives the restart it
	 * counts — an in-memory counter resets every crash and never reaches its cap.
	 */
	resumeAttempts?: number;
	/** Wall-clock of the last transition written for this node. */
	lastActiveAt: number;
	startedAt?: number;
	endedAt?: number;
	/** OS pid of the child process, while it has one. Liveness is decided from this. */
	pid?: number;
	usage?: AgentUsage;
	error?: string;
	launch?: LaunchSpec;
}

export interface RegistryFile {
	version: number;
	/** The root of the tree this registry describes, when there is a single one. */
	rootSessionId?: string;
	updatedAt: number;
	nodes: RegistryNode[];
}

export function emptyRegistry(rootSessionId?: string): RegistryFile {
	return {
		version: REGISTRY_VERSION,
		...(rootSessionId ? { rootSessionId } : {}),
		updatedAt: 0,
		nodes: [],
	};
}

// ------------------------------------------------------------- parsing ----

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageOf(value: any): AgentUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = emptyUsage();
	for (const key of Object.keys(usage) as Array<keyof AgentUsage>) {
		const n = num(value[key]);
		if (n !== undefined) usage[key] = n;
	}
	return usage;
}

function launchOf(value: any): LaunchSpec | undefined {
	if (!value || typeof value !== "object") return undefined;
	const list = (input: unknown) =>
		Array.isArray(input) ? input.filter((v): v is string => typeof v === "string") : undefined;
	const tools = list(value.tools);
	const extensions = list(value.extensions);
	// Distinguishes an explicit empty allowlist ("boot no MCP servers") from an
	// absent one, which is what a record written before scoping existed has. Both
	// currently boot nothing, but only the first is a decision, and a later default
	// must be free to apply to the second.
	const mcpScope = list(value.mcpScope);
	return {
		...(str(value.model) ? { model: value.model as string } : {}),
		...(str(value.thinking) ? { thinking: value.thinking as string } : {}),
		...(tools?.length ? { tools } : {}),
		...(extensions?.length ? { extensions } : {}),
		...(mcpScope ? { mcpScope } : {}),
		notesPath: str(value.notesPath) ?? "",
	};
}

/**
 * Validate one node.
 *
 * Returns `undefined` rather than throwing: one unreadable node must not cost
 * the rest of the tree. A node without a session uuid has no identity and is
 * therefore not a node at all.
 */
export function parseNode(value: unknown): RegistryNode | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const sessionId = str(raw.sessionId);
	if (!sessionId) return undefined;
	return {
		sessionId,
		...(str(raw.parentSessionId) ? { parentSessionId: raw.parentSessionId as string } : {}),
		name: str(raw.name) ?? sessionId.slice(0, 8),
		...(str(raw.taskSummary) ? { taskSummary: raw.taskSummary as string } : {}),
		...(str(raw.cwd) ? { cwd: raw.cwd as string } : {}),
		...(str(raw.parentCwd) ? { parentCwd: raw.parentCwd as string } : {}),
		...(str(raw.model) ? { model: raw.model as string } : {}),
		...(str(raw.persona) ? { persona: raw.persona as string } : {}),
		...(str(raw.contextMode) ? { contextMode: raw.contextMode as string } : {}),
		...(str(raw.sessionFile) ? { sessionFile: raw.sessionFile as string } : {}),
		...(str(raw.sessionDir) ? { sessionDir: raw.sessionDir as string } : {}),
		...(str(raw.promptFile) ? { promptFile: raw.promptFile as string } : {}),
		...(str(raw.agentId) ? { agentId: raw.agentId as string } : {}),
		status: str(raw.status) ?? "hibernated",
		...(str(raw.unfinishedStatus) ? { unfinishedStatus: raw.unfinishedStatus as string } : {}),
		...((num(raw.resumeAttempts) ?? 0) > 0 ? { resumeAttempts: num(raw.resumeAttempts)! } : {}),
		lastActiveAt: num(raw.lastActiveAt) ?? 0,
		...(num(raw.startedAt) !== undefined ? { startedAt: num(raw.startedAt)! } : {}),
		...(num(raw.endedAt) !== undefined ? { endedAt: num(raw.endedAt)! } : {}),
		...(num(raw.pid) !== undefined ? { pid: num(raw.pid)! } : {}),
		...(usageOf(raw.usage) ? { usage: usageOf(raw.usage)! } : {}),
		...(str(raw.error) ? { error: raw.error as string } : {}),
		...(launchOf(raw.launch) ? { launch: launchOf(raw.launch)! } : {}),
	};
}

/**
 * Parse a whole registry file.
 *
 * Anything unparseable — truncated JSON from a `kill -9` mid-write, a file
 * somebody edited by hand, a future version with a shape we do not know —
 * degrades to an empty registry. The alternative (throwing) would mean a bad
 * file could keep the extension, and therefore pi, from starting.
 */
export function parseRegistry(raw: string): RegistryFile {
	let value: any;
	try {
		value = JSON.parse(raw);
	} catch {
		return emptyRegistry();
	}
	if (!value || typeof value !== "object" || !Array.isArray(value.nodes)) return emptyRegistry();
	const nodes: RegistryNode[] = [];
	const seen = new Set<string>();
	for (const entry of value.nodes) {
		const node = parseNode(entry);
		if (!node || seen.has(node.sessionId)) continue;
		seen.add(node.sessionId);
		nodes.push(node);
	}
	return {
		version: num(value.version) ?? REGISTRY_VERSION,
		...(str(value.rootSessionId) ? { rootSessionId: value.rootSessionId as string } : {}),
		updatedAt: num(value.updatedAt) ?? 0,
		nodes,
	};
}

// ------------------------------------------------------------ liveness ----

/**
 * Is this pid still alive?
 *
 * `kill(pid, 0)` is the portable "does this process exist and may I signal it".
 * `EPERM` means it exists but belongs to someone else, which for our purposes is
 * still alive. Anything else — most importantly `ESRCH` — means gone.
 *
 * This is not a proof that the pid is *our* child (pids are recycled), and it is
 * not meant to be: it is a cheap, conservative filter whose only failure mode is
 * showing a node as alive when its pid was reused. Reviving is always explicit,
 * so that mistake costs a line of text, not a process.
 */
export function isPidAlive(pid: number | undefined, kill: (p: number, sig: number) => void = process.kill.bind(process)): boolean {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return true;
	try {
		kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

/**
 * A dead pid is a dead node.
 *
 * Applied when the registry is read, before anything is shown: after a crash
 * every status in the file is frozen at the moment of the crash, so a node that
 * says `running` with a pid nobody can signal is not running, it is gone. It
 * still has its session file, which is what makes it *restorable* rather than
 * merely stale.
 */
export function markDeadNodes(
	nodes: readonly RegistryNode[],
	alive: (pid: number | undefined) => boolean = (pid) => isPidAlive(pid),
): RegistryNode[] {
	return nodes.map((node) => {
		if (node.status === "closed") return { ...node };
		if (alive(node.pid)) return { ...node };
		const { pid: _pid, ...rest } = node;
		return {
			...rest,
			// A child that died mid-failure keeps saying so; hibernation is about the
			// missing process, not about forgetting what happened.
			status: node.status === "failed" ? "failed" : "hibernated",
			// What it was doing before the pid went away is the *whole* input to the
			// auto-resume decision, and this is the function that destroys it: after a
			// `kill -9` the node still says `running`, and one line above we overwrite
			// that with `hibernated`. Preserved here, before it is lost, unless an
			// earlier hibernation already recorded one.
			...(node.unfinishedStatus ? {} : { unfinishedStatus: node.status }),
		};
	});
}

/** Nodes with a session file still on disk, i.e. things a revive could resume. */
export function restorableNodes(
	nodes: readonly RegistryNode[],
	parentSessionId?: string,
	exists: (path: string) => boolean = defaultExists,
): RegistryNode[] {
	return nodes.filter((node) => {
		if (node.status === "closed") return false;
		if (parentSessionId && node.parentSessionId !== parentSessionId) return false;
		return Boolean(node.sessionFile) && exists(node.sessionFile!);
	});
}

function defaultExists(path: string): boolean {
	return existsSync(path);
}

/** Direct children of a node. Depth falls out of repeated application. */
export function childrenOf(nodes: readonly RegistryNode[], sessionId: string): RegistryNode[] {
	return nodes.filter((node) => node.parentSessionId === sessionId);
}

/**
 * Every descendant of a node, breadth first.
 *
 * Cycle-safe: a corrupt file can perfectly well claim that A is B's parent and B
 * is A's, and walking that must terminate rather than hang the startup path.
 */
export function descendantsOf(nodes: readonly RegistryNode[], sessionId: string): RegistryNode[] {
	const out: RegistryNode[] = [];
	const seen = new Set<string>([sessionId]);
	let frontier = [sessionId];
	while (frontier.length > 0) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const child of childrenOf(nodes, id)) {
				if (seen.has(child.sessionId)) continue;
				seen.add(child.sessionId);
				out.push(child);
				next.push(child.sessionId);
			}
		}
		frontier = next;
	}
	return out;
}

/**
 * How stale a previous run's records may be and still come back by themselves.
 *
 * Generous compared with the auto-*resume* window (60 minutes) because the two
 * cost different things: restoring is a record in a list and a line in the
 * switcher, while resuming is a `pi` process spending tokens. A day covers "I
 * quit last night and came back this morning"; older than that the registry is
 * history, and `/agents restore` still offers it on request.
 */
export const DEFAULT_AUTO_RESTORE_MAX_AGE_MINUTES = 24 * 60;

/**
 * The nodes a cold start may adopt without being asked.
 *
 * Two bounds, each closing a different way for this to be a nasty surprise:
 *
 *   - **directory** ({@link treeSpawnedIn}) — the registry spans every project
 *     on the machine, and another project's agents have no business appearing
 *     in this session.
 *   - **age** — without it a registry that has accumulated leftovers resurrects
 *     the same pile at every launch until somebody closes them one by one. A
 *     `maxAgeMinutes` of `0` disables the bound for anyone who wants that.
 *
 * Pure, and takes plain numbers, so the policy can be argued with in tests
 * without a registry file or a clock.
 */
export function autoRestorable(
	nodes: readonly RegistryNode[],
	options: { cwd: string | undefined; now: number; maxAgeMinutes: number },
): RegistryNode[] {
	const mine = treeSpawnedIn(nodes, options.cwd);
	if (options.maxAgeMinutes <= 0) return mine;
	const oldest = options.now - options.maxAgeMinutes * 60_000;
	return mine.filter((node) => node.lastActiveAt >= oldest);
}

/**
 * The part of the tree that belongs to a pi session running in `cwd`.
 *
 * The registry is one file for the whole machine, so "what survived the last
 * run?" is a question about *every* project at once. Adopting another project's
 * leftovers into this session would be wrong twice over: they would appear in a
 * switcher they have nothing to do with, and sending one a message would start a
 * process in a directory nobody is looking at. So auto-restore is scoped and
 * `/agents restore` — an explicit request — is not.
 *
 * Two ways a node qualifies, and the second is only a fallback:
 *
 *   - its `parentCwd` matches. Recorded at spawn from the *parent's* directory,
 *     so a child working in a git worktree is still recognised as this project's
 *     even though its own `cwd` is somewhere else entirely.
 *   - it has no `parentCwd` at all (written before that field existed) and its
 *     own `cwd` is this one. Conservative on purpose: the expensive mistake here
 *     is adopting somebody else's agents, so an unknown parent only qualifies
 *     when the child itself is demonstrably here.
 *
 * Descendants come along with their seed. A grandchild's `parentCwd` is its own
 * parent's directory — a worktree, typically — so matching it directly would
 * strand exactly the deepest agents, which are the ones nobody else can reach.
 */
export function treeSpawnedIn(
	nodes: readonly RegistryNode[],
	cwd: string | undefined,
): RegistryNode[] {
	if (!cwd) return [];
	const owned = new Map<string, RegistryNode>();
	for (const seed of nodes) {
		const mine = seed.parentCwd ? seed.parentCwd === cwd : seed.cwd === cwd;
		if (!mine) continue;
		owned.set(seed.sessionId, seed);
		for (const descendant of descendantsOf(nodes, seed.sessionId)) {
			owned.set(descendant.sessionId, descendant);
		}
	}
	return [...owned.values()];
}

/** One line per node, for `/agents restore` and the `list` action's tail. */
export function describeRestorable(nodes: readonly RegistryNode[]): string {
	if (nodes.length === 0) return "No subagents from a previous run are restorable.";
	const lines = nodes.map((node) => {
		const when = node.lastActiveAt ? new Date(node.lastActiveAt).toISOString() : "unknown";
		return (
			`• ${node.name} (${node.sessionId.slice(0, 8)}) — ${node.status} — last active ${when}` +
			(node.cwd ? `\n    cwd: ${node.cwd}` : "") +
			(node.taskSummary ? `\n    task: ${node.taskSummary}` : "")
		);
	});
	return [
		`${nodes.length} subagent${nodes.length === 1 ? "" : "s"} from a previous run can be restored:`,
		...lines,
	].join("\n");
}

// -------------------------------------------------------------- storage ----

/**
 * Read/modify/write access to the registry file.
 *
 * Every mutation reads the current file first, so two pi processes writing
 * different subtrees do not erase each other's nodes. This is *not* a lock —
 * concurrent writers can still lose an update in a race — and it deliberately is
 * not: the registry is a convenience index, and a lock file that can be
 * orphaned by `kill -9` would be a worse failure mode than a lost line.
 */
export class Registry {
	/**
	 * Resolved lazily, on every access.
	 *
	 * `registryPath()` reads `PI_CODING_AGENT_DIR`, and the extension is
	 * constructed at load time — before a test (or an embedder) has had a chance
	 * to point that somewhere else. Capturing the path in the constructor made
	 * the extension's own tests write into the user's real `~/.pi`.
	 */
	private readonly resolvePath: () => string;

	constructor(
		path?: string | (() => string),
		private readonly now: () => number = Date.now,
	) {
		this.resolvePath =
			typeof path === "function" ? path : path ? () => path : () => registryPath();
	}

	get file(): string {
		return this.resolvePath();
	}

	/** The registry as it is on disk. Never throws; a bad file reads as empty. */
	read(): RegistryFile {
		try {
			return parseRegistry(readFileSync(this.file, "utf-8"));
		} catch {
			return emptyRegistry();
		}
	}

	/**
	 * Read, transform, write — atomically as far as any reader is concerned.
	 *
	 * The temp file is created in the same directory so `rename` stays within one
	 * filesystem (across filesystems it is a copy, which is not atomic). A reader
	 * therefore sees either the whole previous file or the whole new one, never a
	 * half-written one — which matters because the process doing the writing is
	 * precisely the one that might be killed.
	 *
	 * Failure is swallowed: a read-only home directory or a full disk must not
	 * take down a spawn. The registry is an index of things that exist elsewhere.
	 */
	update(mutate: (file: RegistryFile) => RegistryFile | void): RegistryFile {
		const current = this.read();
		const next = mutate(current) ?? current;
		next.version = REGISTRY_VERSION;
		next.updatedAt = this.now();
		this.write(next);
		return next;
	}

	private write(file: RegistryFile): void {
		const target = this.file;
		const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
				encoding: "utf-8",
				mode: 0o600,
			});
			renameSync(temporary, target);
		} catch {
			// Best effort by design; see the doc comment.
			try {
				rmSync(temporary, { force: true });
			} catch {
				/* nothing left to clean up */
			}
		}
	}

	/**
	 * Insert or update one node, keyed by session uuid.
	 *
	 * `upsert` rather than `set` because every lifecycle transition calls it with
	 * only the fields it knows about: a settle knows the status and the usage, a
	 * hibernate knows the pid is gone. Merging keeps the parts nobody re-stated.
	 */
	upsert(node: RegistryNode): RegistryFile {
		return this.update((file) => {
			const index = file.nodes.findIndex((other) => other.sessionId === node.sessionId);
			const merged: RegistryNode = {
				...(index >= 0 ? file.nodes[index] : {}),
				...node,
				lastActiveAt: node.lastActiveAt || this.now(),
			};
			// An explicitly absent pid means "no process any more", which is a real
			// transition and must not be masked by the merge above.
			if (node.pid === undefined) delete merged.pid;
			if (index >= 0) file.nodes[index] = merged;
			else file.nodes.push(merged);
		});
	}

	/** Record the root of this tree, so a cold start knows whose children these are. */
	setRoot(rootSessionId: string): RegistryFile {
		return this.update((file) => {
			file.rootSessionId = rootSessionId;
		});
	}

	/** Forget a node and everything under it: a closed subtree is gone for good. */
	remove(sessionId: string): RegistryFile {
		return this.update((file) => {
			const doomed = new Set([sessionId, ...descendantsOf(file.nodes, sessionId).map((n) => n.sessionId)]);
			file.nodes = file.nodes.filter((node) => !doomed.has(node.sessionId));
		});
	}

	/** The registry with dead pids already reconciled. What callers should read. */
	live(alive?: (pid: number | undefined) => boolean): RegistryFile {
		const file = this.read();
		return { ...file, nodes: markDeadNodes(file.nodes, alive) };
	}
}

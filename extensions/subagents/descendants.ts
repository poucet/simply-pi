/**
 * Agents below this process's children: grandchildren and deeper.
 *
 * A child's own children run inside the child's `pi --mode rpc` process, so none
 * of their events reach the root. Two things that do reach it, without any
 * change to the parent↔child protocol:
 *
 *   - **the registry** — every process writes a node per lifecycle transition,
 *     with `parentSessionId`, so walking parentage down from our own children's
 *     session ids finds the whole tree; status is reconciled against the pid
 *     exactly as `Registry.live()` does;
 *   - **each descendant's session file** — tailed for turns, cost and the
 *     latest thing it did.
 *
 * Polled, cheaply: one `stat` of the registry per tick (re-read only when it
 * changed), one `stat` per descendant session file (only appended bytes read),
 * and no timer at all while this process has no children. Nothing here throws
 * into the UI; an unreadable file is a stale row.
 */

import { statSync } from "node:fs";
import { describeToolCall } from "./manager.ts";
import { type RegistryNode, childrenOf, isPidAlive, markDeadNodes } from "./registry.ts";
import { SessionFileTail } from "./session-log.ts";
import type { DescendantView } from "./types.ts";

/** Statuses during which an agent's clock is still running. */
const ACTIVE = new Set(["starting", "running", "stalled", "waiting"]);

export const DESCENDANT_POLL_MS = 1500;

/** A registry node placed in the tree: how deep, and under whom. */
export interface PlacedNode {
	node: RegistryNode;
	depth: number;
}

/**
 * Every descendant of `rootSessionId`, depth first, each parent before its
 * children, siblings by start time.
 *
 * Depth 1 is a child of the root. Closed nodes are left out with their subtree
 * (closing removes a subtree from the registry anyway; this covers a node that
 * says `closed` before its removal is written). Cycle-safe: a corrupt registry
 * can claim anything about parentage.
 */
export function descendantTree(nodes: readonly RegistryNode[], rootSessionId: string): PlacedNode[] {
	const out: PlacedNode[] = [];
	const seen = new Set<string>([rootSessionId]);
	const walk = (parentId: string, depth: number): void => {
		const children = childrenOf(nodes, parentId)
			.filter((node) => node.status !== "closed" && !seen.has(node.sessionId))
			.sort(
				(a, b) =>
					(a.startedAt ?? a.lastActiveAt) - (b.startedAt ?? b.lastActiveAt) ||
					a.name.localeCompare(b.name),
			);
		for (const node of children) {
			if (seen.has(node.sessionId)) continue;
			seen.add(node.sessionId);
			out.push({ node, depth });
			walk(node.sessionId, depth + 1);
		}
	};
	walk(rootSessionId, 1);
	return out;
}

/** What a descendant's session file says about it so far. */
export interface TranscriptStats {
	/** Whether any entry has been read at all; until then the registry's usage stands in. */
	seen: boolean;
	/** When the session was created (its header), in ms. */
	since?: number;
	turns: number;
	cost: number;
	activity?: string;
	/** Timestamp of the latest message read. */
	lastAt?: number;
}

export function emptyStats(): TranscriptStats {
	return { seen: false, turns: 0, cost: 0 };
}

/**
 * Fold session-file entries into the running stats. Pure; mutates and returns `stats`.
 *
 * A forked child's file opens with a copy of its parent's conversation, and
 * those messages keep their original timestamps — older than the session header.
 * They are not this agent's turns or spend, so they are skipped here, which keeps
 * the numbers in line with what a parent counts for its direct children.
 */
export function applySessionEntries(stats: TranscriptStats, entries: readonly any[]): TranscriptStats {
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		stats.seen = true;
		if (entry.type === "session") {
			const since = Date.parse(entry.timestamp);
			if (Number.isFinite(since)) stats.since = since;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "assistant") continue;
		const at = typeof message.timestamp === "number" ? message.timestamp : undefined;
		if (at !== undefined && stats.since !== undefined && at < stats.since) continue; // inherited
		stats.turns += 1;
		stats.cost += Number(message.usage?.cost?.total) || 0;
		if (at !== undefined) stats.lastAt = at;
		const activity = latestActivity(message);
		if (activity) stats.activity = activity;
	}
	return stats;
}

/** The last tool call an assistant message made, or else the first line of its text. */
function latestActivity(message: any): string | undefined {
	const parts: any[] = Array.isArray(message.content) ? message.content : [];
	const call = parts.filter((part) => part?.type === "toolCall").at(-1);
	if (call) return describeToolCall(String(call.name ?? "tool"), call.arguments);
	if (message.errorMessage) return `error: ${String(message.errorMessage).split("\n")[0]}`;
	const text = parts
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return text ? text.split("\n")[0] : undefined;
}

/**
 * One row: a placed node plus its file stats, as the UI wants it. Pure.
 */
export function toView(
	placed: PlacedNode,
	stats: TranscriptStats,
	parentName: string,
	icon: (status: string) => string,
): DescendantView {
	const { node, depth } = placed;
	const fromFile = stats.seen && (stats.turns > 0 || !node.usage);
	const status = node.status;
	const startedAt = node.startedAt ?? stats.since ?? node.lastActiveAt;
	const endedAt = ACTIVE.has(status) ? undefined : (node.endedAt ?? stats.lastAt ?? node.lastActiveAt);
	return {
		sessionId: node.sessionId,
		parentSessionId: node.parentSessionId ?? "",
		parentName,
		name: node.name,
		status,
		icon: icon(status),
		depth,
		startedAt,
		...(endedAt !== undefined ? { endedAt: Math.max(endedAt, startedAt) } : {}),
		turns: fromFile ? stats.turns : (node.usage?.turns ?? 0),
		cost: fromFile ? stats.cost : (node.usage?.cost ?? 0),
		activity:
			status === "waiting"
				? `asks ${parentName}`
				: (stats.activity ?? node.taskSummary ?? ""),
		...(node.sessionFile ? { sessionFile: node.sessionFile } : {}),
		...(node.cwd ? { cwd: node.cwd } : {}),
		...(node.model ? { model: node.model } : {}),
		...(node.persona ? { persona: node.persona } : {}),
	};
}

export interface TrackerRoot {
	sessionId?: string;
	name: string;
}

export interface TrackerOptions {
	/** The registry file to watch. */
	registryFile: () => string;
	/** Raw registry nodes; called only when the file changed. */
	readNodes: () => RegistryNode[];
	/** This process's direct children. */
	roots: () => TrackerRoot[];
	icon: (status: string) => string;
	/** Something visible changed. */
	onChange: () => void;
	alive?: (pid: number | undefined) => boolean;
	intervalMs?: number;
}

/**
 * Keeps {@link DescendantView}s for every child of this process, fresh.
 *
 * Owned by the root process only — it is UI state, and children paint nothing.
 */
export class DescendantTracker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private registryStamp: string | undefined;
	private nodes: RegistryNode[] = [];
	private tails = new Map<string, { tail: SessionFileTail; stats: TranscriptStats }>();
	private views = new Map<string, DescendantView[]>();
	private signature = "";

	constructor(private readonly options: TrackerOptions) {}

	/** Descendants of one direct child, in tree order. */
	of(rootSessionId: string | undefined): DescendantView[] {
		return rootSessionId ? (this.views.get(rootSessionId) ?? []) : [];
	}

	find(sessionId: string): DescendantView | undefined {
		for (const list of this.views.values()) {
			const found = list.find((view) => view.sessionId === sessionId);
			if (found) return found;
		}
		return undefined;
	}

	/** Run the poll while there are children to look under; stop it otherwise. Idempotent. */
	ensure(): void {
		const wanted = this.liveRoots().length > 0;
		if (wanted && !this.timer) {
			this.timer = setInterval(() => this.poll(), this.options.intervalMs ?? DESCENDANT_POLL_MS);
			this.timer.unref?.();
			this.poll();
		} else if (!wanted && this.timer) {
			this.stop();
			this.clear();
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One tick. Never throws. */
	poll(): void {
		try {
			this.pollUnsafe();
		} catch {
			/* a stale tree is better than a broken UI */
		}
	}

	private liveRoots(): Array<{ sessionId: string; name: string }> {
		return this.options
			.roots()
			.filter((root): root is { sessionId: string; name: string } => Boolean(root.sessionId));
	}

	private clear(): void {
		const had = this.views.size > 0;
		this.views.clear();
		this.tails.clear();
		this.signature = "";
		if (had) this.options.onChange();
	}

	private pollUnsafe(): void {
		const roots = this.liveRoots();
		if (roots.length === 0) return this.clear();

		const stamp = this.stamp();
		if (stamp !== this.registryStamp) {
			this.registryStamp = stamp;
			this.nodes = stamp === undefined ? [] : this.options.readNodes();
		}

		const alive = this.options.alive ?? ((pid: number | undefined) => isPidAlive(pid));
		const names = new Map<string, string>(roots.map((root) => [root.sessionId, root.name]));
		const next = new Map<string, DescendantView[]>();
		const keep = new Set<string>();
		for (const root of roots) {
			const placed = descendantTree(this.nodes, root.sessionId);
			if (placed.length === 0) continue;
			// Liveness only for the nodes we show: the registry spans the machine.
			const reconciled = markDeadNodes(
				placed.map((p) => p.node),
				alive,
			);
			const rows: DescendantView[] = [];
			placed.forEach((p, index) => {
				const node = reconciled[index]!;
				names.set(node.sessionId, node.name);
				keep.add(node.sessionId);
				const stats = this.statsFor(node);
				rows.push(
					toView(
						{ node, depth: p.depth },
						stats,
						names.get(node.parentSessionId ?? "") ?? "its parent",
						this.options.icon,
					),
				);
			});
			next.set(root.sessionId, rows);
		}
		for (const id of [...this.tails.keys()]) if (!keep.has(id)) this.tails.delete(id);

		this.views = next;
		const signature = JSON.stringify([...next.entries()].map(([id, rows]) => [id, rows.map(signatureOf)]));
		if (signature !== this.signature) {
			this.signature = signature;
			this.options.onChange();
		}
	}

	private statsFor(node: RegistryNode): TranscriptStats {
		if (!node.sessionFile) return emptyStats();
		let entry = this.tails.get(node.sessionId);
		if (!entry || entry.tail.file !== node.sessionFile) {
			entry = { tail: new SessionFileTail(node.sessionFile), stats: emptyStats() };
			this.tails.set(node.sessionId, entry);
		}
		const { entries, reset } = entry.tail.read();
		if (reset) entry.stats = emptyStats();
		applySessionEntries(entry.stats, entries);
		return entry.stats;
	}

	private stamp(): string | undefined {
		try {
			const info = statSync(this.options.registryFile());
			return `${info.mtimeMs}:${info.size}`;
		} catch {
			return undefined;
		}
	}
}

/** The fields whose change is worth a repaint; elapsed time is drawn per frame anyway. */
function signatureOf(view: DescendantView): unknown[] {
	return [view.sessionId, view.status, view.depth, view.turns, view.cost, view.activity, view.endedAt];
}

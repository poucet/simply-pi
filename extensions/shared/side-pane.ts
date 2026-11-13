/**
 * Columns a side pane keeps for itself on the right of the terminal.
 *
 * The doc panel sits beside pi's chat by narrowing pi's own layout (see
 * `doc-panel/split.ts`), but overlays are laid out against the whole terminal,
 * so a full-width overlay from another extension (the subagent chat) would be
 * drawn over the panel, or under it, and a selection in it would run on under
 * the panel. The panel publishes what it reserves here; such an overlay takes
 * `columns - reservedRight(columns)` as its width and sits beside the panel.
 *
 * A publisher hands over a function, not a number: it is read on every frame,
 * so a resize or a panel that hides needs no republishing to be right. A
 * change that is not a resize (shown, hidden, closed) is announced to
 * subscribers, so an overlay that caches anything can drop it.
 *
 * Free of pi imports, and kept on `globalThis` for the reason border-badges.ts
 * gives: extensions loaded through jiti need not share a module instance.
 */

/** Columns to keep free on the right of a terminal `columns` wide. */
export type ReserveFn = (columns: number) => number;

const STORE_KEY = Symbol.for("pi.side-pane");

interface Store {
	reserves: Map<string, ReserveFn>;
	subscribers: Set<() => void>;
}

function store(): Store {
	const g = globalThis as Record<symbol, unknown>;
	const existing = g[STORE_KEY] as Partial<Store> | undefined;
	if (existing?.reserves instanceof Map && existing.subscribers instanceof Set) return existing as Store;
	const fresh: Store = { reserves: new Map(), subscribers: new Set() };
	g[STORE_KEY] = fresh;
	return fresh;
}

/** Tell every subscriber the reserved columns changed. A subscriber's error stays its own. */
export function notify(): void {
	for (const subscriber of [...store().subscribers]) {
		try {
			subscriber();
		} catch {
			// One broken subscriber must not keep the others stale.
		}
	}
}

/** Publish `source`'s reserve, replacing its previous one; `undefined` withdraws it. */
export function publish(source: string, reserve: ReserveFn | undefined): void {
	const { reserves } = store();
	if (reserve) reserves.set(source, reserve);
	else if (!reserves.delete(source)) return;
	notify();
}

/** Be told when a reserve is published, withdrawn or changes. Returns the unsubscribe. */
export function subscribe(listener: () => void): () => void {
	const { subscribers } = store();
	subscribers.add(listener);
	return () => {
		subscribers.delete(listener);
	};
}

/**
 * Columns reserved on the right of a terminal `columns` wide: every
 * publisher's, added up, and never all of them, so whatever asks keeps at
 * least one column. A reserve that throws or answers nonsense counts as 0.
 */
export function reservedRight(columns: number): number {
	const cols = Math.max(0, Math.floor(columns));
	let total = 0;
	for (const reserve of store().reserves.values()) {
		try {
			const r = Math.floor(reserve(cols));
			if (Number.isFinite(r) && r > 0) total += r;
		} catch {
			// Counts as nothing reserved.
		}
	}
	return Math.max(0, Math.min(total, cols - 1));
}

/** Empty the store; tests only. */
export function resetForTests(): void {
	const s = store();
	s.reserves.clear();
	s.subscribers.clear();
}

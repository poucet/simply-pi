/**
 * The badge bar in the editor's top border.
 *
 * pi gives an extension exactly one way to own the input editor —
 * `ctx.ui.setEditorComponent()` — and it is a single slot: the last extension to
 * call it wins, silently. `extensions/subagents` already claims it. So a badge
 * bar drawn in that border cannot be assembled by whoever happens to want one;
 * the extension that owns the editor draws it, and everyone else publishes into
 * this registry and never touches the editor at all.
 *
 * That splits the work cleanly. Publishers decide *what* their badges say and
 * what each one means (its `tone`). The renderer decides what a tone looks like
 * in the current theme. Neither imports the other: a publisher needs no terminal
 * and no theme, and the renderer needs no knowledge of MCP or subagents or
 * whatever publishes next.
 *
 * The third thing in here is {@link setRenderer}/{@link hasRenderer}, and it is
 * what keeps that split from being a trap. The bar only exists if somebody is
 * drawing it, and nothing guarantees anybody is — the extension owning the
 * editor may be disabled, or may not be installed at all. A publisher that had
 * simply deleted its own footer line in favour of the bar would then report
 * nothing, anywhere, with no error to explain it. So presence is a fact
 * publishers can ask about, and they keep their own fallback for when the answer
 * is no.
 *
 * Deliberately free of pi imports, so a publisher can be tested headlessly and
 * so this module can be loaded by anything.
 */

/**
 * How a badge should read at a glance.
 *
 * Named after meaning rather than colour, because the renderer owns the mapping
 * and the theme owns the actual colours. A publisher that reaches for "green"
 * instead of "ok" would break the moment someone loads a light theme.
 *
 * The seven, and the distinctions worth keeping:
 *
 *   - `label`   — whose badges these are (`mcp`, `subagents`). The anchor chip at
 *                 the head of a group; without it a bare `2/2` on a shared bar
 *                 belongs to nobody.
 *   - `ok`      — everything that should be working is working.
 *   - `pending` — work in flight. Not yet good, but not bad either, and the
 *                 honest answer is usually "wait". Kept distinct from `warn` so
 *                 that a slow connection never looks like a problem.
 *   - `error`   — broken, and it needs investigating.
 *   - `warn`    — blocked, but not broken, and the user can clear it themselves
 *                 (a login, a confirmation). Kept distinct from `error` because
 *                 the two ask for very different reactions, and a bar that cries
 *                 error at a missing login trains people to ignore red.
 *   - `neutral` — the payload. Plain information carrying no judgement, like a
 *                 tool count: the thing you actually came to read.
 *   - `muted`   — deliberately inactive. A server switched off with
 *                 `/mcp disable` is not neutral information and certainly not a
 *                 fault: it is a choice the user already made, and the bar should
 *                 let them skip over it. This is the distinction from `neutral` —
 *                 `neutral` is information to read, `muted` is information to be
 *                 able to ignore. Rendering them identically loses that, and the
 *                 bar gets noisier every time someone turns something off.
 */
export type BadgeTone = "label" | "ok" | "pending" | "error" | "warn" | "neutral" | "muted";

export interface StatusBadge {
	/**
	 * The content, **unpadded**.
	 *
	 * Padding is the renderer's business, because how much whitespace can survive
	 * around a chip depends on where it is being drawn. The same badges rendered
	 * into pi's footer status line have to use exactly one space per side, since
	 * that line collapses runs of literal spaces; the editor border has no such
	 * rule. A publisher that padded its own text would be right in one place and
	 * wrong in the other.
	 */
	text: string;
	tone: BadgeTone;
}

/** One publisher's contribution to the bar. */
export interface BadgeGroup {
	source: string;
	badges: readonly StatusBadge[];
}

/**
 * The tone → theme-token mapping the renderer is expected to use.
 *
 * Plain strings rather than pi's token unions, so that this module stays free of
 * pi imports; the renderer casts them to its own types. It lives here, and not in
 * the renderer, so that the same badges look the same wherever they are drawn —
 * `extensions/mcp` paints these tones into the footer status line today, and a
 * badge that is green in one place and grey in the other is worse than either.
 *
 * The pairs are ones pi already draws together: every theme defines each
 * `tool*Bg` against the matching status colour, because that is how tool boxes
 * are painted. Borrowing them means a badge stays legible in a theme nobody
 * writing this code has seen, including one a user wrote.
 */
export const RECOMMENDED_TOKENS: Readonly<Record<BadgeTone, { bg: string; fg: string; bold?: boolean }>> = {
	label: { bg: "selectedBg", fg: "accent", bold: true },
	ok: { bg: "toolSuccessBg", fg: "success" },
	pending: { bg: "toolPendingBg", fg: "accent" },
	error: { bg: "toolErrorBg", fg: "error" },
	// Same background as `error`: both are bad news and belong to the same region
	// of the bar; the foreground is what separates "broken" from "blocked".
	warn: { bg: "toolErrorBg", fg: "warning" },
	neutral: { bg: "userMessageBg", fg: "text" },
	muted: { bg: "userMessageBg", fg: "muted" },
};

/**
 * The shared store.
 *
 * On `globalThis`, not in module scope, and this is load-bearing rather than
 * defensive. Extensions are loaded through jiti, and there is no guarantee that
 * `extensions/mcp` and the extension that owns the editor are handed the same
 * instance of this module — the test runner here even sets `moduleCache: false`,
 * which guarantees they are not. A module-scoped singleton would therefore give
 * each side its own private empty registry: mcp would publish into one, the
 * renderer would read the other, and the bar would sit silently blank with
 * nothing anywhere reporting an error. `globalThis` is the one thing they
 * demonstrably share.
 */
const STORE_KEY = Symbol.for("pi.border-badges");

interface Store {
	entries: Map<string, readonly StatusBadge[]>;
	subscribers: Set<() => void>;
	/**
	 * How many renderers are currently drawing the bar. See {@link setRenderer}.
	 *
	 * A count rather than a flag, and that is not hypothetical tidiness: across a
	 * `/reload` the outgoing editor and the incoming one can overlap, and with a
	 * flag the *old* instance's teardown would run last and switch the bar off
	 * while the new one was already drawing it. Publishers would then permanently
	 * believe nobody was rendering.
	 */
	renderers: number;
}

/** A store is only reusable if it still looks like one — see `store()`. */
function usable(value: unknown): value is Store {
	const candidate = value as Partial<Store> | undefined;
	if (!(candidate?.entries instanceof Map) || !(candidate?.subscribers instanceof Set)) return false;
	// Added after the first release of this module, so a store left by the previous
	// generation is usable but has no counter. Repaired in place rather than
	// replaced: replacing would drop the badges of every publisher that has not
	// reloaded yet, and they have no reason to republish.
	if (typeof candidate.renderers !== "number") candidate.renderers = 0;
	return true;
}

function store(): Store {
	const global = globalThis as unknown as Record<symbol, unknown>;
	const existing = global[STORE_KEY];

	// Reuse whatever is already there. A `/reload` re-imports every extension,
	// and reusing the store is what lets a publisher that has already reloaded
	// and a renderer that has not keep talking to each other. The shape check is
	// for the other case: an object left by an *older, incompatible* version of
	// this module. Replacing it loses that generation's badges, which they will
	// republish; trusting it would throw somewhere much less obvious.
	if (usable(existing)) return existing;

	const fresh: Store = { entries: new Map(), subscribers: new Set(), renderers: 0 };
	global[STORE_KEY] = fresh;
	return fresh;
}

/** Do two badge lists say the same thing? Used to skip pointless repaints. */
function same(a: readonly StatusBadge[] | undefined, b: readonly StatusBadge[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.length !== b.length) return false;
	return a.every((badge, i) => badge.text === b[i]?.text && badge.tone === b[i]?.tone);
}

/**
 * Publish (or with `undefined`, withdraw) one source's badges.
 *
 * Callers repaint on every state change, so this is called far more often than
 * anything actually changes; a publish that says nothing new notifies nobody,
 * which keeps a chatty publisher from making the editor border redraw on every
 * heartbeat.
 *
 * Never throws. Publishers call this from the middle of their own lifecycle —
 * mcp does it while connects are settling and while shutting servers down — and
 * a registry that could throw would be able to abort work that matters far more
 * than a badge. A subscriber that throws is contained for the same reason, and
 * cannot take down either the publisher or the other subscribers.
 */
export function publish(source: string, badges: readonly StatusBadge[] | undefined): void {
	try {
		const { entries } = store();
		const previous = entries.get(source);

		if (badges === undefined) {
			if (!entries.delete(source)) return; // already absent: nothing changed
		} else {
			// Copied, so a publisher that keeps mutating its own array cannot
			// reach in and change what the renderer is about to draw.
			const next = badges.map((badge) => ({ text: badge.text, tone: badge.tone }));
			if (same(previous, next)) return;
			entries.set(source, next);
		}

		notify();
	} catch {
		// Cosmetics must never break a caller. Nothing sensible to report to, and
		// nothing the publisher could do about it.
	}
}

/**
 * Every published group, ordered by source.
 *
 * Sorted rather than insertion-ordered on purpose: extensions connect and settle
 * in whatever order the network and the process scheduler decide, so insertion
 * order would reshuffle the bar between runs — and, worse, reshuffle it live as
 * a slow server finally reports in. A bar whose chips move is one people stop
 * being able to read at a glance.
 */
export function snapshot(): BadgeGroup[] {
	try {
		return [...store().entries.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([source, badges]) => ({ source, badges }));
	} catch {
		return [];
	}
}

/** Convenience for a renderer: every badge, in source order, flattened. */
export function flatten(): StatusBadge[] {
	return snapshot().flatMap((group) => [...group.badges]);
}

/**
 * Listen for changes. Returns an unsubscribe function.
 *
 * The callback takes no arguments and is expected to call `snapshot()` itself:
 * a renderer usually wants to coalesce several publishes into one repaint, and
 * handing it a payload it would immediately discard only encourages it to draw
 * more often than it needs to.
 */
export function subscribe(listener: () => void): () => void {
	try {
		const { subscribers } = store();
		subscribers.add(listener);
		return () => {
			try {
				subscribers.delete(listener);
			} catch {
				// A store replaced underneath us has already forgotten this listener.
			}
		};
	} catch {
		return () => {};
	}
}

function notify(): void {
	// Iterated over a copy: a subscriber is allowed to unsubscribe (or subscribe)
	// while being notified, and mutating the live Set mid-iteration would skip
	// somebody. Each is isolated so one throwing renderer cannot silence the rest
	// or, worse, propagate back into the publisher that triggered this.
	for (const listener of [...store().subscribers]) {
		try {
			listener();
		} catch {
			// A broken subscriber is the subscriber's problem.
		}
	}
}

/**
 * Announce that something is drawing the bar (or has stopped).
 *
 * The reason this exists is degradation. A publisher that simply stopped writing
 * its footer status would vanish entirely for anyone who does not run the
 * extension that owns the editor — no bar, no status line, no clue why. So the
 * bar is a *destination that may or may not exist*, and publishers ask.
 *
 * Every call must be paired, and callers must make their teardown idempotent:
 * the count is clamped at zero, but a renderer that decrements twice would still
 * be voting on behalf of a peer that is genuinely still drawing.
 *
 * A change notifies subscribers, because that is what lets a publisher which has
 * already written to the footer take it back down when a renderer appears a
 * moment later. Re-entrancy is safe and bounded: a publisher woken this way
 * republishes the badges it already published, `same()` sees no change, and no
 * second round of notifications happens.
 */
export function setRenderer(present: boolean): void {
	try {
		const state = store();
		const before = state.renderers > 0;
		state.renderers = Math.max(0, state.renderers + (present ? 1 : -1));
		if (before !== state.renderers > 0) notify();
	} catch {
		// Same contract as `publish`: cosmetics must never break a caller.
	}
}

/**
 * Is anything actually drawing the bar right now?
 *
 * For publishers deciding whether their own fallback rendering is still needed.
 * `false` is the safe answer on any failure: showing a status line twice is a
 * cosmetic annoyance, showing it nowhere is a missing feature.
 */
export function hasRenderer(): boolean {
	try {
		return store().renderers > 0;
	} catch {
		return false;
	}
}

/**
 * Drop everything. Only for tests — it exists so a test can start from a known
 * state despite the store deliberately outliving module reloads.
 */
export function resetForTests(): void {
	const state = store();
	state.entries.clear();
	state.subscribers.clear();
	state.renderers = 0;
}

/**
 * Narrow pi's chat while the doc panel is shown, so the panel sits beside the
 * chat instead of on top of it.
 *
 * The panel stays an overlay (it keeps pi's focus, hide and teardown handling);
 * this only takes its columns away from everything else. pi draws in one of two
 * renderers, and each gives a way in:
 *
 *   - **fullscreen** (`TuiAltScreen`, a `ViewportTUI`): the frame is laid out
 *     from `layoutRoot`. We swap in an {@link HStack} of pi's own root and an
 *     empty column as wide as the panel, through the public `setLayoutRoot`.
 *     The transcript's scroll view, mouse hit-testing and selection all live in
 *     that layout, so they keep working inside the narrower column.
 *   - **regular** (`TuiMainScreen`): the frame is `tui.render(width)` and has no
 *     layout root, so the TUI's own `render` is wrapped on the instance to
 *     render at the narrower width. The overlay is composited over the blank
 *     columns afterwards, at the full width.
 *
 * In fullscreen the split's root also tells the caller when a left press lands
 * in the chat (see {@link SplitOptions}`.onChatPress`). It is the only way an
 * extension learns of it: pi-tui's own viewport listener consumes every mouse
 * report before an extension's terminal input listener would see it.
 *
 * pi only swaps renderers when no overlay is open (`switchTuiMode`), so the
 * renderer this was installed on stays the one drawing until the panel goes.
 *
 * Fails safe: anything unexpected at install leaves pi untouched (the panel is
 * then a plain overlay, as before), and an error while rendering drops back to
 * the full width for that frame.
 */

import { type Component, HStack, isViewportTUI, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** The panel never takes the chat below this many columns, unless it would itself go under half. */
const MIN_CHAT = 30;
/** The panel's preferred minimum width. */
const MIN_PANEL = 40;

/** pi-tui's layout-node key (`layout-node.js`), registered globally with `Symbol.for`. */
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** A stack's layout node; its shape is pi-tui's business, we only pass it on. */
type LayoutNodeFn = (this: HStack) => object;

// SAFETY: pi-tui's Stack defines `[LAYOUT_NODE]()` on its prototype
// (components/stack.js). The record type admits it may be missing, and
// `splitLayout` refuses to split when it is.
const stackLayoutNode = (HStack.prototype as unknown as Partial<Record<symbol, LayoutNodeFn>>)[LAYOUT_NODE];

/**
 * The panel's width on a terminal `columns` wide: half, at least
 * {@link MIN_PANEL} while that leaves the chat {@link MIN_CHAT}. The overlay and
 * the reserved column both read it, so they never disagree.
 */
export function panelWidth(columns: number): number {
	const cols = Math.max(0, Math.floor(columns));
	return Math.max(1, Math.floor(cols / 2), Math.min(MIN_PANEL, cols - MIN_CHAT));
}

/**
 * Columns to keep free on the right for a frame `width` wide; 0 for the full
 * width. Never all of them: the chat keeps at least one column.
 */
export type Reserve = (width: number) => number;

export interface SplitOptions {
	/**
	 * A left press landed in the chat and nothing in it claimed the press.
	 * Fullscreen only. Told, never asked: the press goes on to the chat
	 * (selection, the click that follows) as if this were not here. pi's
	 * editor answers only the click, so a press on it arrives here too.
	 */
	onChatPress?: () => void;
}

export interface ChatSplit {
	/** Which renderer path is in use. */
	readonly kind: "layout" | "render";
	/** Give pi back its own layout. Idempotent. */
	remove(): void;
}

/** What the split reaches on the TUI beyond its public interface. */
type SplitTui = TUI & { layoutRoot?: Component; setLayoutRoot?: (root: Component | undefined) => void };

/** Clamp a reserve to [0, width - 1]; an error or a nonsense value means 0. */
function safeReserve(reserve: Reserve, width: number): number {
	try {
		const r = Math.floor(reserve(width));
		return Number.isFinite(r) ? Math.max(0, Math.min(r, width - 1)) : 0;
	} catch {
		return 0;
	}
}

/** An empty column; the overlay is drawn over it. */
const blank: Component = { render: () => [], invalidate() {} };

/** pi's root beside a blank column whose width follows the reserve on every frame. */
class SplitRoot extends HStack {
	constructor(
		readonly chat: Component,
		private readonly reserve: Reserve,
		private readonly columns: () => number,
		private readonly onChatPress?: () => void,
	) {
		super([
			{ component: chat, basis: 0, grow: 1 },
			{ component: blank, basis: 0, shrink: 0 },
		]);
	}

	private sync(width: number): void {
		const spacer = this.entries[1];
		if (spacer) spacer.basis = safeReserve(this.reserve, width);
	}

	override render(width: number): string[] {
		this.sync(width);
		return super.render(width);
	}

	/**
	 * pi-tui offers the layout's components a mouse event deepest first, so this
	 * root sees one only when no component in the chat took it. It takes none
	 * either: forwarding to the children as a Container does would offer them
	 * the event twice.
	 */
	override handleMouse(event: TuiMouseEvent): undefined {
		if (event.type !== "press" || event.button !== "left") return undefined;
		try {
			this.onChatPress?.();
		} catch {
			// The chat's press must never fail because of the panel.
		}
		return undefined;
	}

	[LAYOUT_NODE](): object {
		this.sync(this.columns());
		return stackLayoutNode ? stackLayoutNode.call(this) : {};
	}
}

/** Per renderer, the split installed on it, so a second install replaces rather than stacks. */
const INSTALLED = Symbol.for("simply-pi/doc-panel/split");

/**
 * Narrow everything but overlays by `reserve(width)` columns on `tui`, until
 * `remove()`. Returns undefined, touching nothing, when this TUI offers no way
 * to do it; the caller then just has an overlay.
 */
export function installSplit(tui: TUI, reserve: Reserve, options: SplitOptions = {}): ChatSplit | undefined {
	try {
		const t = tui as SplitTui & { [INSTALLED]?: ChatSplit };
		t[INSTALLED]?.remove();
		const split = isViewportTUI(tui) ? splitLayout(t, reserve, options) : splitRender(t, reserve);
		if (split) t[INSTALLED] = split;
		return split;
	} catch {
		return undefined;
	}
}

function splitLayout(
	tui: SplitTui & { [INSTALLED]?: ChatSplit },
	reserve: Reserve,
	options: SplitOptions,
): ChatSplit | undefined {
	const original = tui.layoutRoot;
	if (!original || typeof tui.setLayoutRoot !== "function") return undefined;
	if (typeof stackLayoutNode !== "function") return undefined;
	const root = new SplitRoot(original, reserve, () => tui.terminal.columns, options.onChatPress);
	tui.setLayoutRoot(root);
	let removed = false;
	const split: ChatSplit = {
		kind: "layout",
		remove: () => {
			if (removed) return;
			removed = true;
			// pi may have mounted another root meanwhile; that one is not ours to replace.
			if (tui.layoutRoot === root) tui.setLayoutRoot?.(original);
			if (tui[INSTALLED] === split) tui[INSTALLED] = undefined;
		},
	};
	return split;
}

function splitRender(tui: SplitTui & { [INSTALLED]?: ChatSplit }, reserve: Reserve): ChatSplit | undefined {
	const prior = tui.render;
	if (typeof prior !== "function") return undefined;
	let removed = false;
	const render = (width: number): string[] => {
		const r = removed ? 0 : safeReserve(reserve, width);
		if (r > 0) {
			try {
				return prior.call(tui, width - r);
			} catch {
				// Fall through to the full width, as if there were no split.
			}
		}
		return prior.call(tui, width);
	};
	tui.render = render;
	const split: ChatSplit = {
		kind: "render",
		remove: () => {
			if (removed) return;
			removed = true;
			// The wrapper is a pass-through from here on even if this assignment
			// is shadowed or lost; restoring is for tidiness, not correctness.
			tui.render = prior;
			if (tui[INSTALLED] === split) tui[INSTALLED] = undefined;
		},
	};
	return split;
}

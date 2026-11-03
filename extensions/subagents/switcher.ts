/**
 * The chat switcher strip.
 *
 * One selectable row of chats — the main conversation first, then every child,
 * each followed by the agents it spawned (marked `└`, read-only when opened):
 *
 *     ● main │ ◐ nav-ping │ └◐ coder-a │ ✓ reviewer●
 *
 * It is rendered under the main editor (as a widget) and again at the bottom of
 * a subagent pane, driven by the same state so the two never disagree.
 *
 * Reaching it is deliberately mundane: press `↓` out of an empty input box.
 * `ctrl+←/→` used to switch chats and cannot: macOS binds it to Spaces.
 *
 * Focus here is **cooperative**. pi has no public way to hand terminal focus to
 * a widget, and a real focus transfer would drag escape/interrupt handling along
 * with it, so the editor keeps input ownership and forwards keys while
 * `focused` is set. That is why every decision below is a pure function taking
 * raw key data rather than a component method.
 */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ChatHost, DescendantView, ManagedAgent } from "./types.ts";

/** The main conversation, always the first entry. */
export const MAIN_ENTRY_ID = "main";

export interface SwitcherEntry {
	/** `MAIN_ENTRY_ID`, or an agent id. */
	id: string;
	label: string;
	icon: string;
	unread: number;
}

/**
 * The slice of pi's `Theme` the strip needs.
 *
 * Structural on purpose: a test can pass a plain object and assert on the text
 * without a terminal, and a real `Theme` still satisfies it.
 */
export interface StripTheme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** Entry ids of agents below this process's children carry this prefix. */
export const NESTED_ENTRY_PREFIX = "nested:";

export function nestedEntryId(sessionId: string): string {
	return `${NESTED_ENTRY_PREFIX}${sessionId}`;
}

export function isNestedEntryId(entryId: string): boolean {
	return entryId.startsWith(NESTED_ENTRY_PREFIX);
}

/** One row of the agent tree: a direct child (numbered) or a descendant of one. */
export type TreeEntry =
	| { kind: "agent"; id: string; agent: ManagedAgent; number: number }
	| { kind: "nested"; id: string; node: DescendantView; under: ManagedAgent };

/**
 * The whole tree, in display order: each direct child in spawn order, followed
 * by everything below it (depth first). Only direct children are numbered.
 *
 * The one ordering the widget, the strip and the chat pane all use, so they
 * never disagree about what comes after what.
 */
export function treeEntries(host: ChatHost): TreeEntry[] {
	const out: TreeEntry[] = [];
	host.agents().forEach((agent, index) => {
		out.push({ kind: "agent", id: agent.id, agent, number: index + 1 });
		for (const node of host.descendants?.(agent) ?? []) {
			out.push({ kind: "nested", id: nestedEntryId(node.sessionId), node, under: agent });
		}
	});
	return out;
}

/** Main chat first, then the tree: each child, then its descendants. */
export function stripEntries(host: ChatHost): SwitcherEntry[] {
	const entries: SwitcherEntry[] = [{ id: MAIN_ENTRY_ID, label: "main", icon: "●", unread: 0 }];
	for (const entry of treeEntries(host)) {
		entries.push(
			entry.kind === "agent"
				? {
						id: entry.id,
						label: entry.agent.name,
						icon: host.statusIcon(entry.agent),
						unread: host.unread(entry.agent.id),
					}
				: // No mailbox reaches us from below a child, so never unread.
					{ id: entry.id, label: entry.node.name, icon: `└${entry.node.icon}`, unread: 0 },
		);
	}
	return entries;
}

/** Selection wraps: stepping off either end lands on the other. */
export function stepIndex(index: number, step: number, count: number): number {
	if (count <= 0) return 0;
	return (((index + step) % count) + count) % count;
}

/**
 * Whether `↓` in the main editor should move into the strip.
 *
 * Restricted to an **empty** buffer: with any text, `↓` is cursor-down and, on
 * the last line, forward history browsing. Stealing that would trade one broken
 * keymap for another. An empty buffer plus `↓` is a no-op today, so nothing is
 * lost.
 */
export function shouldEnterStrip(input: {
	text: string;
	autocompleteOpen: boolean;
	agentCount: number;
}): boolean {
	return input.agentCount > 0 && !input.autocompleteOpen && input.text.length === 0;
}

/** What a key means while the strip has focus. */
export type StripKey = "previous" | "next" | "activate" | "leave" | "insert" | "ignore";

/**
 * `insert` means "the human started typing": the strip gets out of the way and
 * the key is handed to the editor, so a stray focus never eats a character.
 */
export function classifyStripKey(data: string): StripKey {
	if (matchesKey(data, Key.left) || matchesKey(data, "shift+tab")) return "previous";
	if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) return "next";
	if (matchesKey(data, Key.enter)) return "activate";
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.up)) return "leave";
	return isPrintable(data) ? "insert" : "ignore";
}

/** Text a human typed, as opposed to a control code or an escape sequence. */
export function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	for (const character of data) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

/** One line: the whole strip, with the selected entry highlighted. */
export function renderStrip(
	entries: readonly SwitcherEntry[],
	selected: number,
	focused: boolean,
	theme: StripTheme,
): string {
	const cells = entries.map((entry, index) => {
		const label = ` ${entry.icon} ${entry.label}${entry.unread > 0 ? "●" : ""} `;
		if (index === selected) {
			// Two different things: the inverse block is a *cursor* and only appears
			// when the strip owns the keyboard; otherwise the highlight just says
			// "this is the chat you are looking at".
			return focused
				? theme.bg("selectedBg", theme.bold(label))
				: theme.fg("accent", theme.bold(label));
		}
		return entry.unread > 0 ? theme.fg("accent", label) : theme.fg("muted", label);
	});
	return cells.join(theme.fg("dim", "│"));
}

export interface StripCallbacks {
	/** Redraw whatever is currently showing the strip. */
	requestRender(): void;
	/** Open a chat. `MAIN_ENTRY_ID` means "back to the main conversation". */
	open(entryId: string): void;
	/** The chat already on screen; leaving the strip returns the cursor here. */
	current?(): string;
}

/**
 * Selection state for one strip.
 *
 * Selection is tracked by id rather than index because children appear and
 * disappear underneath it; an index would silently point at a different agent.
 */
export class SwitcherStrip {
	private isFocused = false;
	private selectedId = MAIN_ENTRY_ID;

	constructor(
		private host: ChatHost,
		private callbacks: StripCallbacks,
	) {}

	get focused(): boolean {
		return this.isFocused;
	}

	entries(): SwitcherEntry[] {
		return stripEntries(this.host);
	}

	/** Index of the highlighted entry; falls back to the main chat. */
	get selected(): number {
		const wanted = this.isFocused ? this.selectedId : this.home();
		const found = this.entries().findIndex((entry) => entry.id === wanted);
		return found >= 0 ? found : 0;
	}

	focus(): void {
		if (this.isFocused) return;
		this.isFocused = true;
		this.selectedId = this.home();
		this.callbacks.requestRender();
	}

	blur(): void {
		if (!this.isFocused) return;
		this.isFocused = false;
		this.selectedId = this.home();
		this.callbacks.requestRender();
	}

	/** Move the highlight. Only meaningful while the strip has focus. */
	moveBy(step: number): void {
		const entries = this.entries();
		if (entries.length === 0) return;
		this.selectedId = entries[stepIndex(this.selected, step, entries.length)]!.id;
		this.callbacks.requestRender();
	}

	/** Open the highlighted chat and give the keyboard back to the editor. */
	activate(): void {
		this.openIndex(this.selected);
	}

	/** Open the neighbouring chat directly, without ever taking focus (tab/←/→). */
	cycle(step: number): void {
		this.openIndex(stepIndex(this.selected, step, this.entries().length));
	}

	/**
	 * Handle a key while the strip has focus.
	 *
	 * `passThrough` means the strip does not want this key and the caller must
	 * handle `data` as it normally would.
	 */
	handleKey(data: string): "consumed" | "passThrough" {
		switch (classifyStripKey(data)) {
			case "previous":
				this.moveBy(-1);
				return "consumed";
			case "next":
				this.moveBy(1);
				return "consumed";
			case "activate":
				this.activate();
				return "consumed";
			case "leave":
				this.blur();
				return "consumed";
			case "insert":
				this.blur();
				return "passThrough";
			default:
				// ctrl+c, ctrl+d, function keys, mouse reports: these belong to the
				// app, and a strip that happens to hold the cursor must not eat them.
				return "passThrough";
		}
	}

	private openIndex(index: number): void {
		const entry = this.entries()[index];
		this.isFocused = false;
		this.selectedId = MAIN_ENTRY_ID;
		this.callbacks.open(entry?.id ?? MAIN_ENTRY_ID);
		this.callbacks.requestRender();
	}

	private home(): string {
		return this.callbacks.current?.() ?? MAIN_ENTRY_ID;
	}
}

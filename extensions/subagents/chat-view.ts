/**
 * The subagent chat UI.
 *
 * A subagent conversation is just another llm chat, so it is rendered with pi's
 * own chat components (see chat-pane.ts) and framed here with a header, an
 * input box and a switcher bar — the same furniture the main chat has.
 *
 * Why the viewport is hand-rolled: overlays are composited by
 * `TUI.compositeOverlays()`, which calls `component.render(width)` and slices to
 * `maxHeight`. The layout pass that drives `ScrollView.updateLayout()` runs only
 * on the root component tree, so a `ScrollView` inside an overlay renders its
 * whole content and never scrolls. Everything *inside* the viewport is a real pi
 * component; only the slicing is ours.
 *
 * Why this overlay reasserts focus (`keepFocus` below): pi's transcript scroller
 * is registered as a TUI *input listener*, not a component, so it runs strictly
 * before any component's `handleInput`:
 *
 *   TUI.handleTerminalInput -> inputListeners (tui.js:560) -> focusedComponent (tui.js:616)
 *
 * It yields to us only through `shouldDeferViewportInputToOverlay()`
 * (tui-alt-screen.js:378), which is `isOverlayFocused()` — true only while the
 * focused component *is* this overlay. Roughly two dozen call sites in
 * interactive-mode run `this.ui.setFocus(this.editor)` when a dialog, selector,
 * loader, auth prompt or editor swap finishes; none of them know an overlay is
 * up. Once focus lands on the editor, `pageUp` is eaten by the scroller and the
 * *main* transcript moves under our pane. Claiming keys in `handleInput` cannot
 * fix that — we never receive them. Holding focus is the only mechanism.
 *
 * Why the wheel is ours too (`captureWheel` below): pi's default "regular" TUI
 * mode renders on the main screen and deliberately leaves scrolling to the
 * *terminal's* native scrollback — it enables no mouse reporting there (only
 * `TuiAltScreen` sends `?1000h/?1006h`). The whole main conversation therefore
 * lives in the scrollback above the viewport, while an overlay is composited
 * over only the last `terminal.rows` rows (tui.js `compositeOverlays`). Scrolling
 * the terminal up "past the beginning of the terminal window" — wheel or
 * trackpad — slides the viewport into that scrollback, where this overlay does
 * not exist: the main conversation shows above the pane, which reads as "the
 * overlay stopped covering the terminal". Enabling button reporting with SGR
 * encoding while we are up makes the terminal deliver wheel events to the app
 * instead of scrolling, and `handleInput` turns them into pane scrolls. In
 * fullscreen mode the alt screen already owns the mouse, so no DECSETs are
 * touched there — and the wheel never reaches `handleInput`: the alt screen
 * dispatches it to the overlay under the pointer as a `handleMouse` event and
 * scrolls the hidden main transcript if the overlay declines it, so
 * `handleMouse` routes it to the same pane scroll.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type Focusable,
	Key,
	Markdown,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { AgentChatPane, ChatPaneRegistry } from "./chat-pane.ts";
import {
	MAIN_ENTRY_ID,
	SwitcherStrip,
	type TreeEntry,
	renderStrip,
	shouldEnterStrip,
	treeEntries,
} from "./switcher.ts";
import type { ChatHost, ManagedAgent } from "./types.ts";

export type { ChatHost };

let registry: ChatPaneRegistry | undefined;

/** Panes are process-lived; drop them when the session ends. */
export function disposeChatPanes(): void {
	registry?.clear();
	registry = undefined;
}

export function forgetChatPane(agentId: string): void {
	registry?.forget(agentId);
}

function paneRegistry(tui: TUI, host: ChatHost): ChatPaneRegistry {
	registry ??= new ChatPaneRegistry(
		tui,
		(agentId, listener) => host.subscribe(agentId, listener),
		() => tui.requestRender(),
	);
	return registry;
}

function humanDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCost(cost: number): string {
	return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/**
 * A wheel event, in pi's own encoding (`TuiAltScreen.parseWheelEvent`):
 * -1 scrolls the content up, +1 scrolls it down, `undefined` is not a wheel.
 *
 * Regular-mode terminals only send these once `captureWheel` has turned on
 * button reporting; the fullscreen TUI sends them because its scroller defers
 * them to the focused overlay — us.
 */
function parseWheelEvent(data: string): number | undefined {
	const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1]!, 10);
		if ((button & 64) === 0) return undefined; // not a wheel button
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return direction === 0 ? -1 : 1;
	}
	// Legacy X10 encoding: `ESC [ M` followed by three raw bytes.
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return direction === 0 ? -1 : 1;
	}
	return undefined;
}

/**
 * The lines a fullscreen-mode wheel event asks to scroll, or `undefined` for
 * any other mouse event (those are not ours to claim).
 *
 * The alt screen never hands the wheel to `handleInput`: it dispatches it to
 * the overlay under the pointer through `handleMouse`, already accelerated into
 * `wheelDelta`, and scrolls the main transcript — hidden under the overlay —
 * when the overlay declines it.
 */
function wheelLines(event: TuiMouseEvent): number | undefined {
	return event.type === "wheel" && event.wheelDelta ? event.wheelDelta : undefined;
}

/** Any mouse report (SGR or legacy X10), wheel or not. */
function isMouseReport(data: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
}

/**
 * The below-editor widget: one detail line per agent, then the selectable strip.
 *
 * Agents are drawn as a tree: each direct child (numbered), then everything it
 * spawned, indented by depth with the same row shape.
 *
 * The strip is the only thing that reacts to the keyboard; the detail lines
 * above it carry the facts (elapsed, turns, cost, latest activity) that do not
 * fit on one row.
 */
export function switcherLines(
	host: ChatHost,
	theme: Theme,
	strip: SwitcherStrip,
	width?: number,
): string[] {
	const agents = host.agents();
	if (agents.length === 0) return [];
	const now = Date.now();
	/** The part every row shares, whatever its depth. */
	const row = (icon: string, name: string, startedAt: number, endedAt: number | undefined, turns: number, cost: number) =>
		`${icon} ${theme.bold(name)} ` +
		theme.fg("dim", `${humanDuration((endedAt ?? now) - startedAt)} ${turns}t${cost > 0 ? ` ${formatCost(cost)}` : ""}`) +
		"  ";
	const lines = treeEntries(host).map((entry) => {
		if (entry.kind === "nested") {
			const node = entry.node;
			// Under the number column of a direct child, two more per level below.
			const indent = `    ${"  ".repeat(Math.max(0, node.depth - 1))}`;
			return (
				`${indent}${theme.fg("dim", "└")} ` +
				row(node.icon, node.name, node.startedAt, node.endedAt, node.turns, node.cost) +
				theme.fg("muted", node.activity.slice(0, 60))
			);
		}
		const agent = entry.agent;
		const unread = host.unread(agent.id);
		const marker = unread > 0 ? theme.fg("accent", "●") : " ";
		// A blocked child's last activity line is whatever it did before asking,
		// which reads as progress. Say what it is actually doing: nothing.
		const last = agent.pendingQuestion
			? `asks: ${agent.pendingQuestion.question}`
			: (agent.activity.at(-1)?.text ?? agent.task);
		const tail = agent.pendingQuestion
			? theme.fg("warning", last.slice(0, 60))
			: theme.fg("muted", last.slice(0, 60));
		return (
			`${marker} ${theme.fg("dim", String(entry.number))} ` +
			row(host.statusIcon(agent), agent.name, agent.startedAt, agent.endedAt, agent.usage.turns, agent.usage.cost) +
			tail
		);
	});

	// The parent may be mid-turn for minutes; a blocked child is doing nothing at
	// all for all of it, so this must be visible without reading every row.
	const blocked = agents.filter((agent) => agent.pendingQuestion);
	if (blocked.length > 0) {
		lines.unshift(
			theme.fg(
				"warning",
				` ❓ ${blocked.length} subagent${blocked.length === 1 ? "" : "s"} blocked on your answer: ` +
					 blocked.map((agent) => agent.name).join(", "),
			),
		);
	}
	lines.push(` ${renderStrip(strip.entries(), strip.selected, strip.focused, theme)}`);
	lines.push(
		theme.fg(
			"dim",
			strip.focused
				? "  ←/→ select · enter open · ↑/esc back to the input"
				: "  ↓ switcher · enter open · /agents <name>",
		),
	);
	return width ? lines.map((line) => truncateToWidth(line, width, "…")) : lines;
}

// ------------------------------------------------------------------- chat ---

/**
 * Exported for headless rendering checks; use `openSubagentChat` in the app.
 *
 * Shows any entry of the tree. A direct child is a live chat with an input box.
 * Anything deeper is a **read-only transcript**: it runs in a child's process,
 * so this one has no channel to it — the pane is drawn from its session file,
 * re-read by {@link tick}, and says plainly that messages go through its parent.
 */
export class SubagentChatView implements Component, Focusable {
	/** The entry on screen, by id: entries come and go underneath an index. */
	private currentId = MAIN_ENTRY_ID;
	/** Where it was, so a closed entry falls back to its neighbour. */
	private lastIndex = 0;
	private editor: Editor;
	private strip: SwitcherStrip;
	private _focused = false;
	private lastBodyHeight = 10;
	private status?: string;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private host: ChatHost,
		private registry: ChatPaneRegistry,
		private done: () => void,
		startEntryId?: string,
	) {
		const entries = treeEntries(this.host);
		this.currentId = entries.find((entry) => entry.id === startEntryId)?.id ?? entries[0]?.id ?? MAIN_ENTRY_ID;

		// The same strip as the one under the main editor, so the two never disagree
		// about what is selected — here "main" means closing the pane.
		this.strip = new SwitcherStrip(host, {
			requestRender: () => this.tui.requestRender(),
			open: (entryId) => this.openEntry(entryId),
			current: () => this.entry()?.id ?? MAIN_ENTRY_ID,
		});

		this.editor = new Editor(
			tui,
			{ borderColor: (s: string) => theme.fg("border", s), selectList: getSelectListTheme() },
			{ paddingX: 1 },
		);
		this.editor.onSubmit = (text: string) => this.submit(text);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	private entry(): TreeEntry | undefined {
		const entries = treeEntries(this.host);
		if (entries.length === 0) return undefined;
		let index = entries.findIndex((entry) => entry.id === this.currentId);
		// An agent can be closed while its chat is open.
		if (index < 0) index = Math.min(this.lastIndex, entries.length - 1);
		this.lastIndex = index;
		this.currentId = entries[index]!.id;
		return entries[index];
	}

	private agent(): ManagedAgent | undefined {
		const entry = this.entry();
		return entry?.kind === "agent" ? entry.agent : undefined;
	}

	/** True while showing an agent this process cannot talk to. */
	private get readOnly(): boolean {
		return this.entry()?.kind === "nested";
	}

	private pane(): AgentChatPane | undefined {
		const entry = this.entry();
		if (!entry) return undefined;
		if (entry.kind === "agent") return this.registry.get(entry.agent);
		const node = entry.node;
		if (!node.sessionFile) return undefined;
		return this.registry.transcript({
			id: entry.id,
			name: node.name,
			cwd: node.cwd ?? entry.under.cwd,
			sessionFile: node.sessionFile,
		});
	}

	/** Pick up what a read-only transcript's file gained. Driven by a timer while open. */
	tick(): void {
		if (!this.readOnly) return;
		try {
			if (this.pane()?.follow()) this.tui.requestRender();
		} catch {
			/* a transcript that cannot be read stays as it was */
		}
	}

	private submit(text: string): void {
		const trimmed = text.trim();
		const agent = this.agent();
		if (!trimmed || !agent) return;
		this.editor.setText("");
		this.editor.addToHistory?.(trimmed);
		const pane = this.pane();
		if (pane) pane.followEnd = true;
		this.status = `sending to ${agent.name}…`;
		void this.host
			.send(agent.id, trimmed)
			.then(() => {
				this.status = undefined;
			})
			.catch((error: unknown) => {
				this.status = error instanceof Error ? error.message : String(error);
			})
			.finally(() => this.tui.requestRender());
	}

	/** Show another chat. The main chat is not a pane, so it closes this one. */
	private openEntry(entryId: string): void {
		if (entryId === MAIN_ENTRY_ID) return this.done();
		if (treeEntries(this.host).some((entry) => entry.id === entryId)) this.currentId = entryId;
		this.status = undefined;
		this.tui.requestRender();
		// Up to date at once, rather than one tick late.
		this.tick();
	}

	private scroll(lines: number): void {
		const pane = this.pane();
		if (!pane) return;
		pane.scrollTop = Math.max(0, pane.scrollTop + lines);
		pane.followEnd = false;
		this.tui.requestRender();
	}

	/** Fullscreen mode's wheel; regular mode's arrives in `handleInput`. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const lines = wheelLines(event);
		if (lines === undefined) return undefined;
		this.scroll(lines);
		return { handled: true };
	}

	handleInput(data: string): void {
		const readOnly = this.readOnly;
		const editorBusy = !readOnly && this.editor.isShowingAutocomplete();
		const editorText = readOnly ? "" : this.editor.getText();

		// The wheel is pointer input, so it outranks whatever the keyboard focus
		// is doing — it must move the pane in both TUI modes (see the module
		// header), never the terminal's own scrollback or the main transcript.
		const wheel = parseWheelEvent(data);
		if (wheel !== undefined) return this.scroll(wheel);
		// Clicks and drags arrive too, once button reporting is on; there is
		// nothing to do with them, but they must not reach the editor either.
		if (isMouseReport(data)) return;

		// Cooperative focus: anything the strip does not want — a printable
		// character, or a key that belongs to the pane — falls through below.
		if (this.strip.focused && this.strip.handleKey(data) === "consumed") {
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) && !editorBusy) {
			this.done();
			return;
		}
		// The pane's own editor has no autocomplete, so tab is free here (it is not
		// in the main editor, where tab completes).
		if (matchesKey(data, Key.tab)) return this.strip.cycle(1);
		if (matchesKey(data, "shift+tab")) return this.strip.cycle(-1);
		if (
			matchesKey(data, Key.down) &&
			shouldEnterStrip({
				text: editorText,
				autocompleteOpen: editorBusy,
				agentCount: this.host.agents().length,
			})
		) {
			return this.strip.focus();
		}

		const editorEmpty = editorText.length === 0;
		if (editorEmpty && !editorBusy) {
			if (matchesKey(data, Key.left)) return this.strip.cycle(-1);
			if (matchesKey(data, Key.right)) return this.strip.cycle(1);
			if (matchesKey(data, Key.home)) {
				const pane = this.pane();
				if (pane) {
					pane.scrollTop = 0;
					pane.followEnd = false;
				}
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.end)) {
				const pane = this.pane();
				if (pane) pane.followEnd = true;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.up)) return this.scroll(-1);
		}
		if (matchesKey(data, Key.pageUp)) return this.scroll(-Math.max(1, this.lastBodyHeight - 2));
		if (matchesKey(data, Key.pageDown)) return this.scroll(Math.max(1, this.lastBodyHeight - 2));
		if (matchesKey(data, "shift+up")) return this.scroll(-1);
		if (matchesKey(data, "shift+down")) return this.scroll(1);

		// A transcript has no input box: typing goes nowhere rather than into an
		// editor that is not on screen.
		if (readOnly) return;
		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.editor.invalidate();
		this.pane()?.content.invalidate();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const rows = Math.max(8, this.tui.terminal.rows);
		const entry = this.entry();

		const header = this.renderHeader(width, entry);
		const bar = this.renderBar(width);
		const editorLines = entry?.kind === "nested" ? this.renderReadOnlyNotice(width, entry) : this.editor.render(width);
		const bodyHeight = Math.max(1, rows - header.length - bar.length - editorLines.length);
		this.lastBodyHeight = bodyHeight;

		const body: string[] = [];
		const pane = this.pane();
		if (!pane) {
			body.push(
				theme.fg("muted", entry ? " No transcript on disk for this agent." : " No subagents in this session."),
			);
		} else {
			const content = pane.content.render(width);
			const maxScroll = Math.max(0, content.length - bodyHeight);
			pane.scrollTop = pane.followEnd ? maxScroll : Math.min(pane.scrollTop, maxScroll);
			body.push(...content.slice(pane.scrollTop, pane.scrollTop + bodyHeight));
		}
		while (body.length < bodyHeight) body.push("");

		return [...header, ...body.slice(0, bodyHeight), ...editorLines, ...bar];
	}

	private renderHeader(width: number, entry: TreeEntry | undefined): string[] {
		const theme = this.theme;
		if (!entry) return [truncateToWidth(theme.bold(" subagents"), width, "")];
		const parts =
			entry.kind === "agent"
				? [
						`${this.host.statusIcon(entry.agent)} ${entry.agent.status}`,
						entry.agent.persona ? `persona ${entry.agent.persona}` : undefined,
						`context ${entry.agent.contextMode}`,
						entry.agent.model,
						`${entry.agent.usage.turns} turns`,
						formatCost(entry.agent.usage.cost),
						entry.agent.cwd,
					]
				: [
						`${entry.node.icon} ${entry.node.status}`,
						"read-only",
						`spawned by ${entry.node.parentName}`,
						entry.node.persona ? `persona ${entry.node.persona}` : undefined,
						entry.node.model,
						`${entry.node.turns} turns`,
						formatCost(entry.node.cost),
						entry.node.cwd,
					];
		const name = entry.kind === "agent" ? entry.agent.name : entry.node.name;
		const line = ` ${theme.bold(name)} ${theme.fg("dim", parts.filter(Boolean).join(" · "))}`;
		return [truncateToWidth(line, width, "…")];
	}

	/** Stands where the input box would be, and says why there is none. */
	private renderReadOnlyNotice(width: number, entry: Extract<TreeEntry, { kind: "nested" }>): string[] {
		const theme = this.theme;
		const parent = entry.node.parentName;
		return [
			theme.fg("border", "─".repeat(Math.max(0, width))),
			truncateToWidth(
				theme.fg(
					"warning",
					` read-only transcript · ${entry.node.name} runs under ${parent}; message it through ${parent}`,
				),
				width,
				"…",
			),
		];
	}

	private renderBar(width: number): string[] {
		const theme = this.theme;
		const strip = renderStrip(this.strip.entries(), this.strip.selected, this.strip.focused, theme);
		const hint = theme.fg(
			"dim",
			this.strip.focused
				? " ←/→ select · enter open · ↑/esc back to the input"
				: this.readOnly
					? " ←/→ or tab switch · ↓ switcher · pgup/pgdn scroll · esc main"
					: " ←/→ or tab switch · ↓ switcher · pgup/pgdn scroll · enter send · esc main",
		);
		return [
			truncateToWidth(` ${strip}`, width, "…"),
			truncateToWidth(this.status ? theme.fg("warning", ` ${this.status}`) : hint, width, "…"),
		];
	}
}

/**
 * Keep `component` the focused component for as long as the overlay is up.
 *
 * `showOverlay` focuses us once, at open. After that any of pi's
 * `setFocus(this.editor)` paths (dialog dismissal, selector close, editor swap,
 * ambient auth, the reload box, …) silently takes focus away, and with it the
 * scroll keys — see the module header. Rather than enumerate those call sites,
 * we re-take focus whenever we notice it has moved while we are still mounted.
 *
 * Cheap and non-destructive: `setFocus` is idempotent, and we only act when the
 * focus is *not* ours, so a genuine modal opened on top of us (which becomes the
 * focused component and legitimately wants the keyboard) is handled by the
 * `overlayStack` check — pi's own overlays are in the stack, so we defer to
 * anything focused that is also an overlay.
 */
/**
 * Only one of these may be live at a time.
 *
 * Switching chats closes one overlay and opens another, and the close resolves
 * *after* the open (`openEntry` → `done()` → the awaited `ui.custom` settles).
 * Two installations therefore overlap, each having snapshotted, cleared and
 * rebuilt `tui.inputListeners`: the second captures the first's observer, and
 * the first's release then restores a set the second no longer matches. What is
 * left is an observer re-asserting focus onto a component that has been
 * disposed — every keystroke is delivered to something that no longer renders,
 * and the poll steals focus back every 250ms so nothing else can claim it. That
 * is a frozen terminal, which is far worse than the scroll bug this works
 * around, so releasing the previous installation before making a new one is not
 * an optimisation.
 */
let activeFocusHold: (() => void) | undefined;

let activeWheelCapture: (() => void) | undefined;

/**
 * Own the mouse wheel for as long as a full-screen overlay is up (regular mode).
 *
 * In regular mode pi enables no mouse reporting, so the wheel scrolls the
 * terminal's *native* scrollback — which is the main conversation above the
 * overlay's frame, the exact bug this guards against (see the module header).
 * Turning on button reporting (`?1000h`) with SGR encoding (`?1006h`) makes the
 * terminal deliver wheel events to the app instead of scrolling; the overlay's
 * `handleInput` then routes them to the pane. Click-drag selection and terminal
 * link clicking fall back to the terminal's usual shift-bypass while a chat is
 * open, the same trade fullscreen mode makes.
 *
 * Fullscreen mode must not touch the DECSETs: `TuiAltScreen` owns mouse
 * reporting for the whole session there, and resetting it would break the
 * session's input. Wheel events still arrive — the alt screen's scroller defers
 * them to the focused overlay — so `handleInput` works unmodified in both
 * modes. A TUI that reports neither mode (a test double, a future third mode)
 * is treated as not ours to reconfigure.
 *
 * Same single-instance discipline as `keepFocus`: switching chats opens the
 * next overlay before the previous close resolves, so a second capture releases
 * the first rather than leaving two writers fighting over the DECSETs.
 */
export function captureWheel(tui: TUI): () => void {
	if ((tui as { mode?: string }).mode !== "regular") return () => {};

	let stopped = false;
	const write = (sequence: string): void => {
		try {
			(tui.terminal as { write?: (data: string) => void }).write?.(sequence);
		} catch {
			/* a torn-down terminal has already forgotten us */
		}
	};

	/** Idempotent, and safe to call after the terminal is gone. */
	function release(): void {
		if (stopped) return;
		stopped = true;
		if (activeWheelCapture === release) activeWheelCapture = undefined;
		write("\x1b[?1000l\x1b[?1006l");
	}

	// Never leave two captures live; the previous overlay may already be gone.
	activeWheelCapture?.();
	activeWheelCapture = release;
	write("\x1b[?1000h\x1b[?1006h");
	return release;
}

export function keepFocus(tui: TUI, component: Component): () => void {
	const anyTui = tui as any;
	let stopped = false;

	// Never leave two holds live; the previous overlay may already be disposed.
	activeFocusHold?.();

	const focusIsOurs = (): boolean => anyTui.getFocus?.() === component || anyTui.focusedComponent === component;

	/**
	 * True when some *other* overlay legitimately holds focus — a real modal.
	 *
	 * Only an overlay stacked *above* us counts. Deferring to one below is what
	 * froze the terminal: switching chats opens B while A is still stacked and
	 * focused, so B declined to take focus, the keystroke went to A, and A was
	 * disposed a moment later. Focus then sat on a dead component that no longer
	 * rendered or handled input.
	 */
	const otherOverlayFocused = (): boolean => {
		const stack = anyTui.overlayStack as Array<{ component: unknown }> | undefined;
		if (!Array.isArray(stack)) return false;
		const focused = anyTui.getFocus?.() ?? anyTui.focusedComponent;
		if (focused === component) return false;
		const ourIndex = stack.findIndex((entry) => entry.component === component);
		const theirIndex = stack.findIndex((entry) => entry.component === focused);
		if (theirIndex < 0) return false; // focus is not on an overlay at all
		return theirIndex > ourIndex;
	};

	/**
	 * A disposed component must never be focused.
	 *
	 * `ui.custom` disposes an overlay on close, but this hold can outlive that
	 * (an exception in the factory, a reload, a switch racing its own close).
	 * Re-focusing a dead component is the freeze, so treat "no longer in the
	 * overlay stack" as a reason to stop permanently rather than to try harder.
	 */
	const componentIsLive = (): boolean => {
		const stack = anyTui.overlayStack as Array<{ component: unknown }> | undefined;
		// Unknown shape: we cannot prove the component is still alive, and holding
		// focus for a dead one freezes the terminal. Give up the hold instead. The
		// cost of being wrong here is that scroll keys reach the transcript again;
		// the cost of the opposite mistake is a session the human has to kill.
		if (!Array.isArray(stack)) return false;
		return stack.some((entry) => entry.component === component);
	};

	const reassert = (): void => {
		if (stopped) return;
		if (!componentIsLive()) {
			release();
			return;
		}
		if (focusIsOurs() || otherOverlayFocused()) return;
		try {
			tui.setFocus(component as never);
		} catch {
			// A torn-down TUI is not something a chat pane needs to survive.
		}
	};

	// Every keypress passes through the listener chain before the focused
	// component runs, so a focus stolen between frames can be corrected before
	// the next key is dispatched — but only if we run *first*. The alt-screen
	// scroller registers at TUI construction and returns `{consume:true}` for
	// scroll keys, which ends the loop (tui.js:563) before any later listener.
	// `inputListeners` is a plain Set and iterates in insertion order, so we
	// reinsert the existing listeners behind ours to get in front of it.
	const observer = (): undefined => {
		reassert();
		return undefined; // never consume: we only observe
	};
	let removeListener: (() => void) | undefined;
	const listeners = anyTui.inputListeners as Set<unknown> | undefined;
	if (listeners instanceof Set && typeof anyTui.addInputListener === "function") {
		const existing = [...listeners];
		listeners.clear();
		removeListener = anyTui.addInputListener(observer);
		for (const listener of existing) listeners.add(listener);
	} else {
		// Unknown TUI shape: still better to observe late than not at all.
		removeListener = anyTui.addInputListener?.(observer);
	}

	// Focus can also be taken with no input at all (a child event closing a
	// dialog, a background auth prompt). A slow poll covers that without
	// pretending to be a render loop.
	const timer = setInterval(reassert, 250);
	timer.unref?.();

	/** Idempotent, and safe to call after the TUI is gone. */
	function release(): void {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		try {
			removeListener?.();
		} catch {
			/* a torn-down TUI has already forgotten us */
		}
		if (activeFocusHold === release) activeFocusHold = undefined;
	}

	activeFocusHold = release;
	reassert();
	return release;
}

/** How often an open read-only transcript re-reads its session file. */
const TRANSCRIPT_POLL_MS = 1000;

/** Open the full-screen subagent chat, starting on `startEntryId` (an agent id or a nested entry id) if given. */
export async function openSubagentChat(
	ui: ExtensionUIContext,
	host: ChatHost,
	startEntryId?: string,
): Promise<void> {
	let releaseFocus: (() => void) | undefined;
	let releaseWheel: (() => void) | undefined;
	let follow: ReturnType<typeof setInterval> | undefined;
	try {
		await ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const view = new SubagentChatView(
					tui,
					theme,
					host,
					paneRegistry(tui, host),
					() => done(undefined),
					startEntryId,
				);
				// Transcripts have no event stream; their file is followed instead.
				follow = setInterval(() => view.tick(), TRANSCRIPT_POLL_MS);
				follow.unref?.();
				// Deliberately *not* `nonCapturing`: that flag opts out of the very
				// focus that makes pi's scroller defer to us.
				releaseFocus = keepFocus(tui, view);
				releaseWheel = captureWheel(tui);
				return view;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
			},
		);
	} finally {
		if (follow) clearInterval(follow);
		releaseWheel?.();
		releaseFocus?.();
	}
}

// ------------------------------------------------------------------ notes ---

/** The shared-notes overlay component; exported for tests. */
export class TextOverlay implements Component {
	private scrollTop = 0;
	private body: Markdown;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private title: string,
		text: string,
		private done: () => void,
	) {
		this.body = new Markdown(text, 1, 0, getMarkdownTheme());
	}

	/** Same as the chat pane's: fullscreen mode's wheel. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const lines = wheelLines(event);
		if (lines === undefined) return undefined;
		this.scrollTop = Math.max(0, this.scrollTop + lines);
		this.tui.requestRender();
		return { handled: true };
	}

	handleInput(data: string): void {
		// Same wheel ownership as the chat pane — see the module header.
		const wheel = parseWheelEvent(data);
		if (wheel !== undefined) {
			this.scrollTop = Math.max(0, this.scrollTop + wheel);
			this.tui.requestRender();
			return;
		}
		if (isMouseReport(data)) return;
		const page = Math.max(1, this.tui.terminal.rows - 4);
		if (matchesKey(data, Key.escape) || data === "q") return this.done();
		if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
		else if (matchesKey(data, Key.down)) this.scrollTop += 1;
		else if (matchesKey(data, Key.pageUp)) this.scrollTop = Math.max(0, this.scrollTop - page);
		else if (matchesKey(data, Key.pageDown)) this.scrollTop += page;
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else return;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.body.invalidate();
	}

	render(width: number): string[] {
		const rows = Math.max(6, this.tui.terminal.rows);
		const header = truncateToWidth(` ${this.theme.bold(this.title)}`, width, "…");
		const footer = this.theme.fg("dim", " ↑/↓ pgup/pgdn scroll · esc close");
		const bodyHeight = Math.max(1, rows - 2);
		const lines = this.body.render(width);
		const maxScroll = Math.max(0, lines.length - bodyHeight);
		this.scrollTop = Math.min(this.scrollTop, maxScroll);
		const body = lines.slice(this.scrollTop, this.scrollTop + bodyHeight);
		while (body.length < bodyHeight) body.push("");
		return [header, ...body, truncateToWidth(footer, width, "…")];
	}
}

/** Used for the shared mission notes: same overlay, no chat semantics. */
export async function openTextOverlay(
	ui: ExtensionUIContext,
	title: string,
	text: string,
): Promise<void> {
	// Scrolls with the same keys as the chat pane, so it needs the same focus
	// guard — see `keepFocus`.
	let releaseFocus: (() => void) | undefined;
	let releaseWheel: (() => void) | undefined;
	try {
		await ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const overlay = new TextOverlay(tui, theme, title, text, () => done(undefined));
				releaseFocus = keepFocus(tui, overlay);
				releaseWheel = captureWheel(tui);
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
			},
		);
	} finally {
		releaseWheel?.();
		releaseFocus?.();
	}
}

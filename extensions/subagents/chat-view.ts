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
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { AgentChatPane, ChatPaneRegistry } from "./chat-pane.ts";
import { MAIN_ENTRY_ID, SwitcherStrip, renderStrip, shouldEnterStrip } from "./switcher.ts";
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
 * The below-editor widget: one detail line per agent, then the selectable strip.
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
	const lines = agents.map((agent, index) => {
		const unread = host.unread(agent.id);
		const marker = unread > 0 ? theme.fg("accent", "●") : " ";
		const elapsed = humanDuration((agent.endedAt ?? Date.now()) - agent.startedAt);
		const cost = agent.usage.cost > 0 ? ` ${formatCost(agent.usage.cost)}` : "";
		// A blocked child's last activity line is whatever it did before asking,
		// which reads as progress. Say what it is actually doing: nothing.
		const last = agent.pendingQuestion
			? `asks: ${agent.pendingQuestion.question}`
			: (agent.activity.at(-1)?.text ?? agent.task);
		const tail = agent.pendingQuestion
			? theme.fg("warning", last.slice(0, 60))
			: theme.fg("muted", last.slice(0, 60));
		return (
			`${marker} ${theme.fg("dim", String(index + 1))} ${host.statusIcon(agent)} ` +
			`${theme.bold(agent.name)} ${theme.fg("dim", `${elapsed} ${agent.usage.turns}t${cost}`)}  ` +
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

/** Exported for headless rendering checks; use `openSubagentChat` in the app. */
export class SubagentChatView implements Component, Focusable {
	private index = 0;
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
		startAgentId?: string,
	) {
		const agents = this.host.agents();
		const found = agents.findIndex((a) => a.id === startAgentId);
		this.index = found >= 0 ? found : 0;

		// The same strip as the one under the main editor, so the two never disagree
		// about what is selected — here "main" means closing the pane.
		this.strip = new SwitcherStrip(host, {
			requestRender: () => this.tui.requestRender(),
			open: (entryId) => this.openEntry(entryId),
			current: () => this.agent()?.id ?? MAIN_ENTRY_ID,
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

	private agent(): ManagedAgent | undefined {
		const agents = this.host.agents();
		// An agent can be closed while its chat is open.
		if (this.index >= agents.length) this.index = Math.max(0, agents.length - 1);
		return agents[this.index];
	}

	private pane(): AgentChatPane | undefined {
		const agent = this.agent();
		return agent ? this.registry.get(agent) : undefined;
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
		const found = this.host.agents().findIndex((agent) => agent.id === entryId);
		if (found >= 0) this.index = found;
		this.status = undefined;
		this.tui.requestRender();
	}

	private scroll(lines: number): void {
		const pane = this.pane();
		if (!pane) return;
		pane.scrollTop = Math.max(0, pane.scrollTop + lines);
		pane.followEnd = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const editorBusy = this.editor.isShowingAutocomplete();

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
				text: this.editor.getText(),
				autocompleteOpen: editorBusy,
				agentCount: this.host.agents().length,
			})
		) {
			return this.strip.focus();
		}

		const editorEmpty = this.editor.getText().length === 0;
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
		const agent = this.agent();

		const header = this.renderHeader(width, agent);
		const bar = this.renderBar(width);
		const editorLines = this.editor.render(width);
		const bodyHeight = Math.max(1, rows - header.length - bar.length - editorLines.length);
		this.lastBodyHeight = bodyHeight;

		const body: string[] = [];
		const pane = agent ? this.registry.get(agent) : undefined;
		if (!pane) {
			body.push(theme.fg("muted", " No subagents in this session."));
		} else {
			const content = pane.content.render(width);
			const maxScroll = Math.max(0, content.length - bodyHeight);
			pane.scrollTop = pane.followEnd ? maxScroll : Math.min(pane.scrollTop, maxScroll);
			body.push(...content.slice(pane.scrollTop, pane.scrollTop + bodyHeight));
		}
		while (body.length < bodyHeight) body.push("");

		return [...header, ...body.slice(0, bodyHeight), ...editorLines, ...bar];
	}

	private renderHeader(width: number, agent: ManagedAgent | undefined): string[] {
		const theme = this.theme;
		if (!agent) return [truncateToWidth(theme.bold(" subagents"), width, "")];
		const parts = [
			`${this.host.statusIcon(agent)} ${agent.status}`,
			agent.persona ? `persona ${agent.persona}` : undefined,
			`context ${agent.contextMode}`,
			agent.model,
			`${agent.usage.turns} turns`,
			formatCost(agent.usage.cost),
			agent.cwd,
		].filter(Boolean);
		const line = ` ${theme.bold(agent.name)} ${theme.fg("dim", parts.join(" · "))}`;
		return [truncateToWidth(line, width, "…")];
	}

	private renderBar(width: number): string[] {
		const theme = this.theme;
		const strip = renderStrip(this.strip.entries(), this.strip.selected, this.strip.focused, theme);
		const hint = theme.fg(
			"dim",
			this.strip.focused
				? " ←/→ select · enter open · ↑/esc back to the input"
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

/** Open the full-screen subagent chat, starting on `startAgentId` if given. */
export async function openSubagentChat(
	ui: ExtensionUIContext,
	host: ChatHost,
	startAgentId?: string,
): Promise<void> {
	let releaseFocus: (() => void) | undefined;
	try {
		await ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const view = new SubagentChatView(
					tui,
					theme,
					host,
					paneRegistry(tui, host),
					() => done(undefined),
					startAgentId,
				);
				// Deliberately *not* `nonCapturing`: that flag opts out of the very
				// focus that makes pi's scroller defer to us.
				releaseFocus = keepFocus(tui, view);
				return view;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
			},
		);
	} finally {
		releaseFocus?.();
	}
}

// ------------------------------------------------------------------ notes ---

class TextOverlay implements Component {
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

	handleInput(data: string): void {
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
	try {
		await ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const overlay = new TextOverlay(tui, theme, title, text, () => done(undefined));
				releaseFocus = keepFocus(tui, overlay);
				return overlay;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
			},
		);
	} finally {
		releaseFocus?.();
	}
}

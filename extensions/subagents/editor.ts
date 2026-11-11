/**
 * The main input box, wrapped.
 *
 * Exactly one behaviour is added: `↓` in an **empty** buffer moves into the
 * switcher strip below the editor. With any text in the buffer `↓` is untouched,
 * so cursor-down and forward history browsing behave exactly as they do without
 * this extension — that restriction is the whole point, `↓` on an empty buffer
 * is a no-op today so nothing is taken away.
 *
 * While the strip has focus this editor still owns the keyboard and forwards
 * keys to it (see switcher.ts on why focus is cooperative). Anything the strip
 * does not want comes straight back here, so a stray focus can never swallow
 * typing.
 *
 * Subclassing `CustomEditor` rather than implementing `EditorComponent` keeps
 * every app-level keybinding — interrupt, ctrl+d, model switching, extension
 * shortcuts — working; interactive mode copies those handlers onto whatever we
 * return.
 *
 * The second behaviour, added later, is the **badge bar**: the top border is
 * repainted, right-aligned, with whatever any extension has published to
 * `shared/border-badges.ts`. This extension does not own those badges and does
 * not know what they mean — it owns the editor, and `setEditorComponent` is a
 * single slot, so it is the only thing in the process that *can* draw there. The
 * layout is in `badge-bar.ts`, pure and testable; what is left here is the theme,
 * the repaint and the lifecycle.
 */

import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	Key,
	type TUI,
	getKeybindings,
	matchesKey,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	RECOMMENDED_TOKENS,
	setRenderer,
	snapshot,
	subscribe,
	type StatusBadge,
} from "../shared/border-badges.ts";
import { type BarPainter, borderSlot, composeBar } from "./badge-bar.ts";
import { moveToLineEnd, peekHistory, shouldHoldDown } from "./history-guard.ts";
import { type SwitcherStrip, shouldEnterStrip } from "./switcher.ts";

/**
 * pi's full theme, as opposed to the four-function `EditorTheme` the editor is
 * handed. Badges need `bg`/`fg`/`bold`, which only the full one has, so it is
 * threaded in from the extension context instead.
 */
type BadgeTheme = ExtensionContext["ui"]["theme"];

/**
 * Does this theme paint anything at all?
 *
 * Chips lean on their backgrounds to be separable. If the theme hands text back
 * untouched — a stub, a build with colour compiled out — the composer switches to
 * a visible `·` separator instead. Probed rather than asked, because pi's `Theme`
 * exposes no capability flag: `getColorMode()` chooses between two colour depths
 * and never between colour and none.
 */
function themePaints(theme: BadgeTheme): boolean {
	const probe = "x";
	try {
		return theme.fg("accent", probe) !== probe && theme.bg("selectedBg", probe) !== probe;
	} catch {
		// `fg`/`bg` throw on a token they do not know, which is its own answer.
		return false;
	}
}

export class SubagentsEditor extends CustomEditor {
	/** Undoes the badge subscription. Called at most once; see `dispose`. */
	private unsubscribe?: () => void;
	private disposed = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private strip: SwitcherStrip,
		private agentCount: () => number,
		/**
		 * The live full theme, or `undefined` when there is none to be had.
		 *
		 * A getter rather than a value because `ui.theme` is itself a live getter and
		 * `/theme` swaps the object underneath us. Reading it per frame is what makes
		 * a theme switch repaint the bar correctly, with no theme-change event to
		 * subscribe to — pi does not offer one.
		 */
		private badgeTheme: () => BadgeTheme | undefined = () => undefined,
	) {
		super(tui, theme, keybindings);
		// Being constructed *is* mounting: pi calls the factory when it installs the
		// editor, and from that moment this instance is what draws the bar. Publishers
		// ask `hasRenderer()` to decide whether they still need their own fallback, so
		// announcing late would leave a window where the same facts are on the status
		// line and in the border at once.
		try {
			setRenderer(true);
			// The repaint mechanism. `requestRender` is the documented way for anything
			// that is not mid-render to ask the TUI to draw again, and it coalesces, so a
			// burst of publishes costs one frame. Deliberately not a timer: badges change
			// when servers change, which is rarely and unpredictably, and polling would
			// mean either lag or waking the terminal forever.
			this.unsubscribe = subscribe(() => {
				try {
					this.tui.requestRender();
				} catch {
					// A TUI torn down between the publish and this callback. Nothing to
					// draw on and nothing to report to.
				}
			});
		} catch {
			// The badge bar is decoration. An input box that failed to construct is not.
		}
	}

	/**
	 * Stop drawing the bar and stop being counted as a renderer.
	 *
	 * Idempotent, and it has to be: `index.ts` disposes the outgoing editor both
	 * when a new one is created and at `session_shutdown`, and across a reload both
	 * can happen. A second decrement would vote away a peer that is genuinely still
	 * drawing — `setRenderer` counts precisely so the overlap is survivable, and
	 * that only works if each instance votes exactly once.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.unsubscribe?.();
		} catch {
			/* a store replaced underneath us has already forgotten this listener */
		}
		this.unsubscribe = undefined;
		setRenderer(false);
	}

	/**
	 * The input box, with badges laid into the right-hand end of its top border.
	 *
	 * Everything interesting is in `badge-bar.ts`; the three facts that live here
	 * are that `borderColor` is the exact function the base class builds its rule
	 * with (so an exact string match can find that rule among the lines it
	 * returns), that a scroll indicator is re-themed rather than sliced, and that
	 * any failure must return the base class's lines untouched. A broken badge must
	 * never be able to break typing.
	 */
	render(width: number): string[] {
		const lines = super.render(width);
		try {
			const groups = snapshot();
			if (groups.length === 0) return lines;

			// The same expression the base class pushes for an unscrolled border, built
			// the same way (per-character theming, hence `.repeat` outside the call).
			// The other thing that can be in that slot is pi's `─── ↑ 3 more ` indicator,
			// which `borderSlot` hands back as a `lead` to draw around.
			const slot = borderSlot(lines, this.borderColor("─").repeat(width), "top", stripTerminalSequences);
			if (slot === undefined) return lines;

			const painter = this.painter();
			// The bar gets the columns the indicator is not using — all of them when
			// there is no indicator, since `lead` is then the empty string. `composeBar`
			// keeps at least `MIN_LEAD_RULE` rule characters before its first chip, so
			// "bail before the two touch" is the same condition as "bail when it does not
			// fit", and both come back as `undefined`.
			const bar = composeBar(groups, width - painter.width(slot.lead), painter);
			if (bar === undefined) return lines;

			// The lead is re-painted rather than sliced out of the themed original: pi
			// builds the whole indicator with one `borderColor` call, and cutting a themed
			// string at a column boundary means cutting inside escape sequences. Applying
			// the same function to the same text per run is what the plain rule already
			// does (`borderColor("─").repeat(width)`), so the result is identical to look
			// at and there is no partial escape to get wrong.
			const head = slot.lead === "" ? "" : this.borderColor(slot.lead);

			// Copied rather than mutated: the array came from the base class and may be
			// something it holds on to.
			const painted = [...lines];
			painted[slot.index] = head + bar;
			return painted;
		} catch {
			return lines;
		}
	}

	/** Theme-dependent half of the composer's input. */
	private painter(): BarPainter {
		const theme = this.badgeTheme();
		const paints = theme !== undefined && themePaints(theme);
		return {
			rule: (text: string) => this.borderColor(text),
			chip: (badge: StatusBadge) => {
				if (!paints || !theme) return badge.text;
				const style = RECOMMENDED_TOKENS[badge.tone];
				try {
					// Bold the text, then pad *outside* it, then colour the lot. Byte for
					// byte what `extensions/mcp` builds for the status line — the point of
					// sharing `RECOMMENDED_TOKENS` is that a badge cannot look like one thing
					// in the footer and another in the border, and nesting the emphasis
					// differently is a way for that to drift without anybody noticing.
					const body = style.bold ? theme.bold(badge.text) : badge.text;
					// Casts because the shared registry names pi's theme tokens as plain
					// strings on purpose — it must not import pi. A token this theme does not
					// know throws, and the catch below costs that badge its colour, never
					// the border.
					return theme.bg(
						style.bg as Parameters<BadgeTheme["bg"]>[0],
						theme.fg(style.fg as Parameters<BadgeTheme["fg"]>[0], ` ${body} `),
					);
				} catch {
					return badge.text;
				}
			},
			// Never `.length`: every string above is full of escape sequences, and
			// counting those as columns would push the line past the terminal edge and
			// wrap every frame after it.
			width: visibleWidth,
			paints,
		};
	}

	handleInput(data: string): void {
		try {
			if (this.strip.focused) {
				if (this.strip.handleKey(data) === "consumed") {
					this.tui.requestRender();
					return;
				}
			} else if (
				matchesKey(data, Key.down) &&
				shouldEnterStrip({
					text: this.getText(),
					autocompleteOpen: this.isShowingAutocomplete(),
					agentCount: this.agentCount(),
				})
			) {
				this.strip.focus();
				this.tui.requestRender();
				return;
			}
		} catch {
			// The input box must never break because of a subagent bug: leave strip
			// mode and fall through to ordinary editing.
			try {
				this.strip.blur();
			} catch {
				/* nothing left to do but keep typing */
			}
		}
		if (this.holdDown(data)) return;
		super.handleInput(data);
	}

	/**
	 * Keep `↓` from emptying the box by stepping past the newest history entry
	 * (see history-guard.ts). Matched with the same keybinding lookup the base
	 * class uses, so a rebound cursor-down is guarded too. True when the key was
	 * handled here; any doubt or error answers false and the base class runs.
	 */
	private holdDown(data: string): boolean {
		try {
			if (!getKeybindings().matches(data, "tui.editor.cursorDown")) return false;
			const hold = shouldHoldDown({
				textEmpty: this.getText().length === 0,
				autocompleteOpen: this.isShowingAutocomplete(),
				history: peekHistory(this),
			});
			if (!hold || !moveToLineEnd(this)) return false;
			this.tui.requestRender();
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * Factory for `ctx.ui.setEditorComponent`.
 *
 * `onCreate` hands back the TUI, which is the only handle an extension gets for
 * requesting a redraw of a widget it does not own.
 */
export function subagentsEditorFactory(options: {
	strip: SwitcherStrip;
	agentCount: () => number;
	/** Live accessor for pi's full theme; see `SubagentsEditor.badgeTheme`. */
	badgeTheme?: () => BadgeTheme | undefined;
	/**
	 * Handed the TUI *and* the instance.
	 *
	 * The instance matters because there is no teardown hook on `EditorComponent`:
	 * nothing tells an editor it has been replaced. The extension knows, so it
	 * keeps the reference and calls `dispose()` itself.
	 */
	onCreate?: (tui: TUI, editor: SubagentsEditor) => void;
}) {
	return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const editor = new SubagentsEditor(
			tui,
			theme,
			keybindings,
			options.strip,
			options.agentCount,
			options.badgeTheme,
		);
		options.onCreate?.(tui, editor);
		return editor;
	};
}

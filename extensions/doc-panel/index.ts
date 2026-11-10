/**
 * Show a markdown file in a side panel on the right of pi's terminal.
 *
 * Agents write scratch docs meant for the human: instructions, a checklist, a
 * draft to review. Reading one in the chat means scrolling through tool output;
 * this puts it beside the chat, rendered, and keeps it current while the agent
 * edits it.
 *
 *   - `show_doc({ path })`, a tool: open (or swap to) a file. The result tells
 *     the agent the panel is open and returns none of the file.
 *   - `/doc <path>` opens any markdown file, `/doc` reopens the last one,
 *     `/doc close` closes it.
 *   - {@link KEYS}`.toggle` hides and shows the panel, so the chat under it can
 *     be read; {@link KEYS}`.focus` gives the panel the keyboard for scrolling,
 *     and Esc hands it back.
 *
 * The panel is an overlay, not a layout split: pi has no way to narrow the chat,
 * so the chat keeps its full width and the panel covers its right half. It is
 * shown **non-capturing**, so opening it, even from a tool call mid-turn, never
 * takes the keyboard from the editor.
 *
 * Live reload watches the file's directory (see `watch.ts`), so editors that
 * save by rename, and a file deleted and recreated, keep updating.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hasRenderer, publish, subscribe } from "../shared/border-badges.ts";
import { DocPanel, type DocState, type PanelKeys } from "./panel.ts";
import { type FileWatch, watchFile } from "./watch.ts";

/**
 * The two global keys. Neither is bound by pi (docs/keybindings.md): `alt+l`
 * moves focus right, into the panel; `alt+h` hides it.
 */
export const KEYS: PanelKeys = { focus: "alt+l", toggle: "alt+h" };

/** Above this the file is refused: the panel is for docs, not logs. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Where the badge bar files this extension's chips. */
const BADGE_SOURCE = "doc-panel";

/** The slice of pi's UI the controller uses; `ctx.ui` in a session, a fake in tests. */
type Ui = Pick<ExtensionContext["ui"], "custom" | "notify" | "setStatus">;

interface OpenPanel {
	path: string;
	panel: DocPanel;
	tui: TUI;
	handle?: OverlayHandle;
	watch?: FileWatch;
	close: () => void;
}

/**
 * Owns the one panel a session can have.
 *
 * Exported for tests, which drive it with a fake `ui.custom` that behaves like
 * pi's overlay host.
 */
export class DocPanelController {
	private open?: OpenPanel;
	/** Survives closing, for `/doc` with no argument and the toggle key. */
	lastPath?: string;
	private ui?: Ui;
	private unsubscribe?: () => void;

	/**
	 * Show `path` (absolute), opening the panel or swapping its file. Rejects,
	 * without touching the panel, if the file can't be read.
	 */
	async show(ui: Ui, path: string): Promise<void> {
		const text = await readDoc(path);
		this.ui = ui;
		this.lastPath = path;

		const open = this.open;
		if (open) {
			open.watch?.close();
			open.path = path;
			open.panel.setDoc(basename(path), text);
			open.watch = this.watch(open);
			open.handle?.setHidden(false);
			this.publishBadge();
			return;
		}

		let created: OpenPanel | undefined;
		void ui
			.custom<void>(
				(tui, theme, _keybindings, done) => {
					const panel = new DocPanel({
						theme,
						markdownTheme: getMarkdownTheme,
						rows: () => tui.terminal.rows,
						isFocused: () => created?.handle?.isFocused() ?? false,
						unfocus: () => created?.handle?.unfocus(),
						hide: () => this.setHidden(true),
						requestRender: () => tui.requestRender(),
						keys: KEYS,
					});
					panel.setDoc(basename(path), text);
					created = { path, panel, tui, close: () => done() };
					created.watch = this.watch(created);
					this.open = created;
					return Object.assign(panel, {
						// Runs however the panel goes away: `/doc close`, a session
						// shutdown, or pi tearing its overlays down.
						dispose: () => {
							created?.watch?.close();
							if (this.open === created) this.open = undefined;
							this.publishBadge();
						},
					});
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "50%",
						minWidth: 40,
						// The panel renders the terminal's height itself; this only
						// stops a stray extra line from ever pushing it off-screen.
						maxHeight: "100%",
						nonCapturing: true,
					},
					onHandle: (handle) => {
						if (created) created.handle = handle;
					},
				},
			)
			.catch((error: unknown) => {
				ui.notify(`doc panel failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
	}

	close(): void {
		this.open?.close();
	}

	isOpen(): boolean {
		return this.open !== undefined;
	}

	/** Hide or show; with nothing open, the toggle reopens the last doc. */
	async toggle(ui: Ui): Promise<void> {
		const open = this.open;
		if (open?.handle) {
			this.setHidden(!open.handle.isHidden());
		} else if (!open && this.lastPath) {
			await this.show(ui, this.lastPath);
		}
	}

	/** Give the panel the keyboard, showing it first if hidden; pressed again, give it back. */
	focus(): void {
		const handle = this.open?.handle;
		if (!handle) return;
		if (handle.isFocused()) {
			handle.unfocus();
			return;
		}
		this.setHidden(false);
		handle.focus();
	}

	private setHidden(hidden: boolean): void {
		const open = this.open;
		if (!open?.handle) return;
		// Hiding a focused overlay hands focus back by itself (pi-tui's setHidden).
		open.handle.setHidden(hidden);
		open.tui.requestRender();
		this.publishBadge();
	}

	private watch(open: OpenPanel): FileWatch {
		const path = open.path;
		const reload = async () => {
			let state: DocState = { kind: "ok" };
			let text: string | undefined;
			try {
				text = await readDoc(path);
			} catch (error) {
				state = (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "error", message: describe(error) };
			}
			// The file may have been swapped while this read was in flight.
			if (this.open !== open || open.path !== path) return;
			if (text === undefined) open.panel.setState(state);
			else open.panel.setContent(text, state);
		};
		return watchFile(
			path,
			() => void reload(),
			(error) => open.panel.setState({ kind: "error", message: `not watching: ${describe(error)}` }),
		);
	}

	/**
	 * While the panel is hidden, say so in the editor's badge bar (or the footer
	 * when nothing draws the bar), so a hidden doc isn't forgotten.
	 */
	private publishBadge(): void {
		const open = this.open;
		const hidden = open?.handle?.isHidden() === true;
		const name = open ? basename(open.path) : "";
		publish(
			BADGE_SOURCE,
			hidden
				? [
						{ text: "doc", tone: "label" },
						{ text: `${name} · ${KEYS.toggle}`, tone: "muted" },
					]
				: undefined,
		);
		this.ui?.setStatus(BADGE_SOURCE, hidden && !hasRenderer() ? `doc ${name} hidden (${KEYS.toggle})` : undefined);
		// A badge renderer may appear or go after this; follow it for the footer fallback.
		if (hidden && !this.unsubscribe) this.unsubscribe = subscribe(() => this.publishBadge());
		if (!hidden && this.unsubscribe) {
			const unsubscribe = this.unsubscribe;
			this.unsubscribe = undefined;
			unsubscribe();
		}
	}
}

/** Read a doc, refusing what isn't a regular file of a sensible size. */
export async function readDoc(path: string): Promise<string> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error(`${path} is not a file`);
	if (info.size > MAX_BYTES) throw new Error(`${path} is ${info.size} bytes; the panel shows files up to ${MAX_BYTES}`);
	return readFile(path, "utf8");
}

/** A tool or command path, against the session's cwd. Tolerates the `@path` form agents sometimes use. */
export function resolveDocPath(cwd: string, path: string): string {
	const bare = path.trim().replace(/^@/, "");
	return isAbsolute(bare) ? bare : resolve(cwd, bare);
}

function describe(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return "no such file";
	return code ?? (error instanceof Error ? error.message : String(error));
}

function displayPath(cwd: string, path: string): string {
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

export default function docPanel(pi: ExtensionAPI): void {
	const controller = new DocPanelController();

	pi.registerTool({
		name: "show_doc",
		label: "Show doc",
		description:
			"Show a markdown file to the human, rendered, in a side panel beside the chat. Use it for a " +
			"doc meant for the human to read or act on: instructions, a checklist, a review, a plan " +
			"awaiting their answer. Write the file first, then call this. The panel reloads " +
			"whenever the file changes, so to update what they see, edit the file; calling " +
			"show_doc again with another path swaps the doc. The result says the panel is open " +
			"and does not return the file's contents. Interactive sessions only.",
		promptSnippet: "Show a markdown doc meant for the human in a side panel beside the chat",
		promptGuidelines: [
			"When you write a doc for the human to read or act on, show it with show_doc instead of pasting it into chat.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Markdown file to show, absolute or relative to the working directory" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				throw new Error(
					"show_doc needs pi's interactive terminal and this session has none (a subagent, or print/RPC mode). " +
						"Give the human the doc's path instead.",
				);
			}
			const path = resolveDocPath(ctx.cwd, params.path);
			try {
				await controller.show(ctx.ui, path);
			} catch (error) {
				throw new Error(`cannot show ${params.path}: ${describe(error)}`);
			}
			const shown = displayPath(ctx.cwd, path);
			return {
				content: [
					{
						type: "text",
						text:
							`${shown} is open in the side panel. It reloads when the file changes; ` +
							"call show_doc with another path to swap it.",
					},
				],
				details: { path },
			};
		},
	});

	pi.registerCommand("doc", {
		description: "Show a markdown file in the side panel: /doc <path>, /doc (last doc), /doc close",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/doc needs the interactive terminal", "error");
				return;
			}
			const arg = args.trim();
			if (arg === "close") {
				controller.close();
				return;
			}
			const path = arg ? resolveDocPath(ctx.cwd, arg) : controller.lastPath;
			if (!path) {
				ctx.ui.notify("No doc yet: /doc <path>", "warning");
				return;
			}
			try {
				await controller.show(ctx.ui, path);
			} catch (error) {
				ctx.ui.notify(`cannot show ${arg || path}: ${describe(error)}`, "error");
			}
		},
	});

	pi.registerShortcut(KEYS.toggle, {
		description: "Hide or show the doc panel",
		handler: async (ctx) => {
			try {
				await controller.toggle(ctx.ui);
			} catch (error) {
				ctx.ui.notify(`cannot reopen the doc: ${describe(error)}`, "error");
			}
		},
	});

	pi.registerShortcut(KEYS.focus, {
		description: "Focus the doc panel to scroll it (Esc gives focus back)",
		handler: () => controller.focus(),
	});

	pi.on("session_shutdown", () => controller.close());
}

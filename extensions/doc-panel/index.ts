/**
 * Show markdown files in a side panel on the right of pi's terminal, one tab each.
 *
 * Agents write scratch docs meant for the human: instructions, a checklist, a
 * draft to review. Images including SVG are drawn inline. Reading one in the chat means scrolling through tool output;
 * this puts it beside the chat, rendered, and keeps it current while the agent
 * edits it.
 *
 *   - `show_doc({ path })`, a tool: open a file in a new tab, or switch to its
 *     tab if it is open already. The result tells the agent the panel is open
 *     and which tab it is, and returns none of the file.
 *   - `/doc <path>` does the same for any markdown file; `/doc` lists the open
 *     docs (reopening the last one if the panel is closed); `/doc close` closes
 *     them all.
 *   - {@link KEYS}`.cycle` steps the panel hidden → shown → focused → hidden:
 *     hidden so the chat under it can be read, focused to scroll and switch
 *     tabs (`tab`/`shift+tab`, `1`–`9`, `x` closes one). Esc hands the
 *     keyboard back and leaves the panel shown.
 *
 * The panel is an overlay, and while it is shown the chat (transcript, editor,
 * footer) is narrowed to the columns left of it (see `split.ts`), so nothing is
 * covered; hiding or closing it gives the chat its full width back. Where the
 * chat can't be narrowed the panel falls back to covering its right half. It is
 * shown **non-capturing**, so opening it, even from a tool call mid-turn, never
 * takes the keyboard from the editor.
 *
 * Live reload watches each open file's directory (see `watch.ts`), so editors
 * that save by rename, and a file deleted and recreated, keep updating; a
 * tab's watch closes with the tab.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { hasRenderer, publish, subscribe } from "../shared/border-badges.ts";
import { DocPanel, type DocState, type PanelKeys } from "./panel.ts";
import { type ChatSplit, installSplit, panelWidth } from "./split.ts";
import { type FileWatch, watchFile } from "./watch.ts";

/**
 * The one global key. pi-tui takes `ctrl+shift+d` for its debug dump before
 * any shortcut or component sees it (the same dump is `/debug`), so it is
 * claimed through `ui.onTerminalInput`, which runs first: see {@link claimKey}.
 */
export const KEYS: PanelKeys = { cycle: "ctrl+shift+d" };

/** Above this the file is refused: the panel is for docs, not logs. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Where the badge bar files this extension's chips. */
const BADGE_SOURCE = "doc-panel";

/** The slice of pi's UI the controller uses; `ctx.ui` in a session, a fake in tests. */
type Ui = Pick<ExtensionContext["ui"], "custom" | "notify" | "setStatus">;

interface OpenPanel {
	panel: DocPanel;
	tui: TUI;
	handle?: OverlayHandle;
	/** One per open tab, by path. */
	watches: Map<string, FileWatch>;
	split?: ChatSplit;
	close: () => void;
}

/** Which tab a doc became: 1-based, of how many. */
export interface ShownTab {
	tab: number;
	of: number;
}

/**
 * Owns the one panel a session can have, and its tabs.
 *
 * Exported for tests, which drive it with a fake `ui.custom` that behaves like
 * pi's overlay host.
 */
export class DocPanelController {
	private open?: OpenPanel;
	/** Survives closing, for `/doc` with no argument and the cycle key. */
	lastPath?: string;
	private ui?: Ui;
	private unsubscribe?: () => void;

	/**
	 * Show `path` (absolute) in its own tab and switch to it, opening the panel
	 * if needed; a path already open switches to its tab, with the text read
	 * fresh. Rejects, without touching the panel, if the file can't be read.
	 */
	async show(ui: Ui, path: string): Promise<ShownTab> {
		const text = await readDoc(path);
		this.ui = ui;
		this.lastPath = path;

		const open = this.open;
		if (open) {
			const index = open.panel.open(path, basename(path), text);
			if (!open.watches.has(path)) open.watches.set(path, this.watch(open, path));
			open.handle?.setHidden(false);
			this.publishBadge();
			return { tab: index + 1, of: open.panel.docs.length };
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
						closeTab: (index) => this.closeTab(index),
						requestRender: () => tui.requestRender(),
						keys: KEYS,
					});
					panel.open(path, basename(path), text);
					created = { panel, tui, watches: new Map(), close: () => done() };
					created.watches.set(path, this.watch(created, path));
					this.open = created;
					const open = created;
					// Reserve the panel's columns only while this panel is the open one and showing.
					open.split = installSplit(tui, (width) =>
						this.open === open && open.handle && !open.handle.isHidden() ? panelWidth(width) : 0,
					);
					return Object.assign(panel, {
						// Runs however the panel goes away: `/doc close`, a session
						// shutdown, or pi tearing its overlays down.
						dispose: () => {
							created?.split?.remove();
							for (const watch of created?.watches.values() ?? []) watch.close();
							created?.watches.clear();
							if (this.open === created) this.open = undefined;
							this.publishBadge();
						},
					});
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						// A getter, read on every frame, so the overlay and the columns
						// the split keeps free agree after a resize.
						get width() {
							return panelWidth(created?.tui.terminal.columns ?? 80);
						},
						// The panel renders the terminal's height itself; this only
						// stops a stray extra line from ever pushing it off-screen.
						maxHeight: "100%",
						nonCapturing: true,
					},
					onHandle: (handle) => {
						if (!created) return;
						created.handle = handle;
						// The split reads the handle; draw once more now that it can.
						created.tui.requestRender();
					},
				},
			)
			.catch((error: unknown) => {
				ui.notify(`doc panel failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
		return { tab: 1, of: 1 };
	}

	/** Close every tab, and the panel. */
	close(): void {
		this.open?.close();
	}

	/** Close tab `index` (0-based) and its watch; the last tab closes the panel. */
	closeTab(index: number): void {
		const open = this.open;
		const doc = open?.panel.docs[index];
		if (!open || !doc) return;
		if (open.panel.docs.length === 1) {
			this.close();
			return;
		}
		open.watches.get(doc.key)?.close();
		open.watches.delete(doc.key);
		open.panel.remove(index);
		this.publishBadge();
	}

	isOpen(): boolean {
		return this.open !== undefined;
	}

	/** The open docs' paths, in tab order, and which is current (0-based). */
	tabs(): { paths: string[]; current: number } {
		const panel = this.open?.panel;
		return { paths: panel?.docs.map((doc) => doc.key) ?? [], current: panel?.currentIndex ?? 0 };
	}

	/**
	 * The one key: hidden → shown → focused → hidden. With nothing open it
	 * reopens the last doc; with no last doc it says how to open one.
	 */
	async cycle(ui: Ui): Promise<void> {
		const open = this.open;
		if (!open) {
			if (this.lastPath) await this.show(ui, this.lastPath);
			else ui.notify("No doc yet: /doc <path>", "info");
			return;
		}
		const handle = open.handle;
		if (!handle) return;
		if (handle.isHidden()) this.setHidden(false);
		else if (!handle.isFocused()) handle.focus();
		// Hiding a focused overlay hands focus back by itself.
		else this.setHidden(true);
	}

	/** Show the panel if it is hidden; nothing if closed. */
	reveal(): void {
		this.setHidden(false);
	}

	private setHidden(hidden: boolean): void {
		const open = this.open;
		if (!open?.handle) return;
		// Hiding a focused overlay hands focus back by itself (pi-tui's setHidden).
		open.handle.setHidden(hidden);
		open.tui.requestRender();
		this.publishBadge();
	}

	private watch(open: OpenPanel, path: string): FileWatch {
		const reload = async () => {
			let state: DocState = { kind: "ok" };
			let text: string | undefined;
			try {
				text = await readDoc(path);
			} catch (error) {
				state = (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "error", message: describe(error) };
			}
			// The tab or the panel may have closed while this read was in flight;
			// update ignores a path that is no longer open.
			if (this.open !== open) return;
			open.panel.update(path, text, state);
		};
		return watchFile(
			path,
			() => void reload(),
			(error) => open.panel.update(path, undefined, { kind: "error", message: `not watching: ${describe(error)}` }),
		);
	}

	/**
	 * While the panel is hidden, say so in the editor's badge bar (or the footer
	 * when nothing draws the bar), so a hidden doc isn't forgotten.
	 */
	private publishBadge(): void {
		const open = this.open;
		const hidden = open?.handle?.isHidden() === true;
		const docs = open?.panel.docs ?? [];
		const current = docs[open?.panel.currentIndex ?? 0];
		const name = (current?.name ?? "") + (docs.length > 1 ? ` +${docs.length - 1}` : "");
		publish(
			BADGE_SOURCE,
			hidden
				? [
						{ text: "doc", tone: "label" },
						{ text: `${name} · ${KEYS.cycle}`, tone: "muted" },
					]
				: undefined,
		);
		this.ui?.setStatus(BADGE_SOURCE, hidden && !hasRenderer() ? `doc ${name} hidden (${KEYS.cycle})` : undefined);
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

/**
 * Claim {@link KEYS}`.cycle` for `controller`. A terminal input listener sees
 * every key before pi-tui's own global keys (its debug dump is this one), the
 * editor's shortcuts and the focused component, so the key does one thing
 * wherever the focus is, and the panel never sees it as well. The release of
 * the key (kitty protocol) is swallowed too, so it can't reach the debug dump.
 */
export function claimKey(ui: Ui & Pick<ExtensionContext["ui"], "onTerminalInput">, controller: DocPanelController): () => void {
	return ui.onTerminalInput((data) => {
		if (!matchesKey(data, KEYS.cycle)) return undefined;
		if (!isKeyRelease(data)) {
			controller.cycle(ui).catch((error: unknown) => ui.notify(`cannot reopen the doc: ${describe(error)}`, "error"));
		}
		return { consume: true };
	});
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
			"whenever the file changes, so to update what they see, edit the file. Each path gets " +
			"its own tab; calling show_doc with another path opens it in a new tab and switches to " +
			"it, and with a path already open switches back to its tab. The result says which tab " +
			"it is and does not return the file's contents. Interactive sessions only.",
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
			let tab: ShownTab;
			try {
				tab = await controller.show(ctx.ui, path);
			} catch (error) {
				throw new Error(`cannot show ${params.path}: ${describe(error)}`);
			}
			const shown = displayPath(ctx.cwd, path);
			return {
				content: [
					{
						type: "text",
						text: `${shown} is open in the side panel, tab ${tab.tab} of ${tab.of}. It reloads when the file changes.`,
					},
				],
				details: { path, ...tab },
			};
		},
	});

	pi.registerCommand("doc", {
		description: "Show a markdown file in a side-panel tab: /doc <path>, /doc (list open docs), /doc close (all)",
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
			if (!arg && controller.isOpen()) {
				controller.reveal();
				const { paths, current } = controller.tabs();
				const list = paths.map((p, i) => `${i === current ? "▸" : " "} ${i + 1} ${displayPath(ctx.cwd, p)}`);
				ctx.ui.notify(`Open docs (${KEYS.cycle} to focus, then tab or 1–9):\n${list.join("\n")}`, "info");
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

	// Listeners are dropped on every session switch and reload, and session_start
	// follows each, so the key is claimed again there.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") claimKey(ctx.ui, controller);
	});

	pi.on("session_shutdown", () => controller.close());
}

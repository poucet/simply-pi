/**
 * The controller and the file watch, against a fake overlay host that behaves
 * like pi's: `custom` calls the factory, then shows a non-capturing overlay and
 * hands its handle over; `done` hides it and disposes the component.
 */

import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { claimKey, DocPanelController, KEYS, resolveDocPath } from "../index.ts";
import { resetForTests, snapshot } from "../../shared/border-badges.ts";
import { watchFile } from "../watch.ts";

// The panel asks pi for its markdown theme, which needs a loaded theme.
initTheme("dark", false);

/** A theme that paints nothing, so the output reads as text. */
const plainTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check` passes or give up; file events are asynchronous and their timing varies. */
async function eventually(check: () => void, ms = 2_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		try {
			check();
			return;
		} catch (error) {
			if (Date.now() - start > ms) throw error;
			await tick(20);
		}
	}
}

function fakeUi() {
	const state = {
		component: undefined as { render(width: number): string[]; dispose?(): void; handleInput?(d: string): void } | undefined,
		options: undefined as OverlayOptions | undefined,
		hidden: false,
		focused: false,
		shown: 0,
		notes: [] as string[],
		status: undefined as string | undefined,
	};
	// `render` reports the width it was asked for, so a test can see the split narrow it.
	const tui: { terminal: { rows: number; columns: number }; requestRender(): void; render(width: number): string[] } = {
		terminal: { rows: 20, columns: 200 },
		requestRender: () => {},
		render: (width) => [String(width)],
	};
	const ui = {
		notify: (message: string) => state.notes.push(message),
		setStatus: (_key: string, text: string | undefined) => {
			state.status = text;
		},
		custom: (factory: any, options: any) =>
			new Promise<void>((resolve) => {
				let disposed = false;
				const done = () => {
					if (disposed) return;
					disposed = true;
					state.component?.dispose?.();
					state.component = undefined;
					resolve();
				};
				state.component = factory(tui, plainTheme, {}, done);
				state.options = options.overlayOptions;
				state.shown++;
				const handle: Partial<OverlayHandle> = {
					setHidden: (hidden) => {
						state.hidden = hidden;
						if (hidden) state.focused = false;
					},
					isHidden: () => state.hidden,
					focus: () => {
						state.focused = true;
					},
					unfocus: () => {
						state.focused = false;
					},
					isFocused: () => state.focused,
				};
				// pi hands the handle over a microtask after the factory runs.
				queueMicrotask(() => options.onHandle?.(handle));
			}),
	};
	return { ui: ui as any, state, tui };
}

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "doc-panel-"));
}

test("paths resolve against cwd and tolerate a leading @", () => {
	assert.equal(resolveDocPath("/w", "docs/a.md"), "/w/docs/a.md");
	assert.equal(resolveDocPath("/w", "@docs/a.md"), "/w/docs/a.md");
	assert.equal(resolveDocPath("/w", "/abs/a.md"), "/abs/a.md");
});

test("show opens one non-capturing right-hand overlay, and a second path opens a second tab in it", async () => {
	const dir = scratch();
	writeFileSync(join(dir, "a.md"), "# Alpha\n");
	writeFileSync(join(dir, "b.md"), "# Beta\n");
	const { ui, state } = fakeUi();
	const controller = new DocPanelController();
	await controller.show(ui, join(dir, "a.md"));
	await tick();
	assert.equal(state.shown, 1);
	assert.equal(state.options?.nonCapturing, true);
	assert.equal(state.options?.anchor, "right-center");
	assert.equal(state.options?.width, 100, "half of the 200-column terminal");
	assert.equal(state.component!.render(100).length, 20, "fills the terminal height");
	assert.match(state.component!.render(100).join("\n"), /Alpha/);

	assert.deepEqual(await controller.show(ui, join(dir, "b.md")), { tab: 2, of: 2 });
	assert.equal(state.shown, 1, "a tab in the same overlay, not a second overlay");
	assert.match(state.component!.render(100).join("\n"), /Beta/);
	assert.match(state.component!.render(100)[0]!, /a\.md.*b\.md/);

	controller.close();
	assert.equal(controller.isOpen(), false);
	rmSync(dir, { recursive: true, force: true });
});

test("a missing file is refused and opens nothing", async () => {
	const { ui, state } = fakeUi();
	const controller = new DocPanelController();
	await assert.rejects(controller.show(ui, "/nonexistent/doc.md"), /ENOENT/);
	assert.equal(state.shown, 0);
});

test("the cycle key steps shown → focused → hidden → shown, with a badge while hidden, and reopens the last doc after close", async () => {
	resetForTests();
	const dir = scratch();
	writeFileSync(join(dir, "a.md"), "# Alpha\n");
	const { ui, state } = fakeUi();
	const controller = new DocPanelController();
	await controller.cycle(ui);
	assert.match(state.notes.at(-1) ?? "", /No doc yet/, "nothing ever opened: says how");
	assert.equal(state.shown, 0);

	await controller.show(ui, join(dir, "a.md"));
	await tick();
	assert.deepEqual([state.hidden, state.focused], [false, false], "show never takes the keyboard");

	await controller.cycle(ui);
	assert.deepEqual([state.hidden, state.focused], [false, true], "shown → focused");
	state.component!.handleInput!("\x1b");
	assert.deepEqual([state.hidden, state.focused], [false, false], "Esc gives focus back and leaves it shown");

	await controller.cycle(ui);
	await controller.cycle(ui);
	assert.deepEqual([state.hidden, state.focused], [true, false], "focused → hidden");
	assert.deepEqual(
		snapshot().find((g) => g.source === "doc-panel")?.badges.map((b) => b.text),
		["doc", `a.md · ${KEYS.cycle}`],
	);
	assert.match(state.status ?? "", /hidden/, "no badge renderer in tests, so the footer says it");

	await controller.cycle(ui);
	assert.deepEqual([state.hidden, state.focused], [false, false], "hidden → shown");
	assert.equal(snapshot().find((g) => g.source === "doc-panel"), undefined);
	assert.equal(state.status, undefined);

	controller.close();
	await controller.cycle(ui);
	await tick();
	assert.equal(state.shown, 2, "with nothing open it reopens the last doc");
	controller.close();
	rmSync(dir, { recursive: true, force: true });
});

test("the cycle key is claimed before pi sees it, wherever the focus is, and its release is swallowed", async () => {
	const dir = scratch();
	writeFileSync(join(dir, "a.md"), "# Alpha\n");
	const { ui, state } = fakeUi();
	let listener: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const claimUi = Object.assign(ui, {
		onTerminalInput: (handler: typeof listener) => {
			listener = handler;
			return () => {
				listener = undefined;
			};
		},
	});
	const controller = new DocPanelController();
	const release = claimKey(claimUi, controller);
	await controller.show(ui, join(dir, "a.md"));
	await tick();

	assert.equal(listener!("x"), undefined, "other keys pass through");
	assert.equal(listener!("\x1b[100;6u"), undefined, "ctrl+shift+d is left to pi's debug dump");
	assert.deepEqual(listener!("\x1b[93;5u"), { consume: true }, "ctrl+], kitty protocol");
	await tick();
	assert.equal(state.focused, true);
	assert.deepEqual(listener!("\x1b[93;5:3u"), { consume: true }, "its release");
	await tick();
	assert.equal(state.focused, true, "a release does not step the cycle");
	assert.deepEqual(listener!("\x1d"), { consume: true }, "ctrl+], legacy (GS)");
	await tick();
	assert.equal(state.hidden, true);
	listener!("\x1b[27;5;93~"); // xterm modifyOtherKeys
	await tick();
	assert.equal(state.hidden, false);
	release();
	assert.equal(listener, undefined);
	controller.close();
	rmSync(dir, { recursive: true, force: true });
});

test("tabs: a path already open switches to its tab, x closes one and its watch, the last tab closes the panel", async () => {
	resetForTests();
	const dir = scratch();
	for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.md`), `# ${n.toUpperCase()}\n`);
	const { ui, state } = fakeUi();
	const controller = new DocPanelController();
	assert.deepEqual(await controller.show(ui, join(dir, "a.md")), { tab: 1, of: 1 });
	await tick();
	await controller.show(ui, join(dir, "b.md"));
	assert.deepEqual(await controller.show(ui, join(dir, "c.md")), { tab: 3, of: 3 });

	writeFileSync(join(dir, "a.md"), "# A again\n");
	assert.deepEqual(await controller.show(ui, join(dir, "a.md")), { tab: 1, of: 3 }, "dedupe: back to its tab");
	assert.match(state.component!.render(80).join("\n"), /A again/, "with the text read fresh");
	assert.equal(controller.tabs().paths.length, 3);

	// A watched tab updates while another is current.
	writeFileSync(join(dir, "c.md"), "# C two\n");
	await tick(300);
	state.component!.handleInput!("3");
	assert.match(state.component!.render(80).join("\n"), /C two/);

	state.component!.handleInput!("x");
	assert.deepEqual(controller.tabs().paths, [join(dir, "a.md"), join(dir, "b.md")]);
	// A closed tab's watch is gone: writing its file changes nothing.
	writeFileSync(join(dir, "c.md"), "# C three\n");
	await tick(300);
	await controller.show(ui, join(dir, "c.md"));
	assert.match(state.component!.render(80).join("\n"), /C three/, "reopened, read fresh");
	assert.equal(controller.tabs().current, 2);

	controller.closeTab(0);
	controller.closeTab(0);
	assert.equal(controller.isOpen(), true);
	assert.deepEqual(controller.tabs().paths, [join(dir, "c.md")]);
	state.component!.handleInput!("x");
	assert.equal(controller.isOpen(), false, "closing the last tab closes the panel");
	assert.equal(state.component, undefined);
	rmSync(dir, { recursive: true, force: true });
});

test("close closes every tab, and reopening brings back only the last doc", async () => {
	const dir = scratch();
	for (const n of ["a", "b"]) writeFileSync(join(dir, `${n}.md`), `# ${n}\n`);
	const { ui } = fakeUi();
	const controller = new DocPanelController();
	await controller.show(ui, join(dir, "a.md"));
	await tick();
	await controller.show(ui, join(dir, "b.md"));
	controller.close();
	assert.equal(controller.isOpen(), false);
	assert.deepEqual(controller.tabs().paths, []);
	await controller.cycle(ui);
	await tick();
	assert.deepEqual(controller.tabs().paths, [join(dir, "b.md")]);
	controller.close();
	rmSync(dir, { recursive: true, force: true });
});

test("the panel reloads on write, on atomic rename, and survives delete and recreate", async () => {
	const dir = scratch();
	const file = join(dir, "doc.md");
	writeFileSync(file, "# one\n");
	const { ui, state } = fakeUi();
	const controller = new DocPanelController();
	await controller.show(ui, file);
	await tick();
	const text = () => state.component!.render(80).join("\n");

	writeFileSync(file, "# two\n");
	await eventually(() => assert.match(text(), /two/));

	// How editors that save atomically do it: write elsewhere, rename over.
	writeFileSync(join(dir, ".doc.md.tmp"), "# three\n");
	renameSync(join(dir, ".doc.md.tmp"), file);
	await eventually(() => assert.match(text(), /three/));

	rmSync(file);
	await eventually(() => assert.match(state.component!.render(80)[0]!, /deleted/));
	assert.match(text(), /three/, "the last text stays on screen");

	writeFileSync(file, "# four\n");
	await eventually(() => assert.match(text(), /four/));
	assert.doesNotMatch(state.component!.render(80)[0]!, /deleted/);

	controller.close();
	rmSync(dir, { recursive: true, force: true });
});

test("a watch on a directory that does not exist reports instead of throwing", () => {
	const errors: Error[] = [];
	const watch = watchFile("/nonexistent-dir/doc.md", () => {}, (error) => errors.push(error));
	watch.close();
	assert.equal(errors.length, 1);
});

test("the chat is narrowed by the panel's width while it shows, and gets it back when hidden or closed", async () => {
	const dir = scratch();
	writeFileSync(join(dir, "a.md"), "# Alpha\n");
	const { ui, state, tui } = fakeUi();
	const controller = new DocPanelController();
	await controller.show(ui, join(dir, "a.md"));
	await tick();
	assert.deepEqual(tui.render(200), ["100"], "chat in the left 100 columns, panel in the right 100");

	tui.terminal.columns = 120;
	assert.equal(state.options?.width, 60, "the overlay follows a resize");
	assert.deepEqual(tui.render(120), ["60"], "and so does the chat");

	await controller.cycle(ui); // focused
	await controller.cycle(ui); // hidden
	assert.equal(state.hidden, true);
	assert.deepEqual(tui.render(120), ["120"], "hidden: full width");

	await controller.cycle(ui);
	assert.deepEqual(tui.render(120), ["60"]);

	controller.close();
	assert.deepEqual(tui.render(120), ["120"], "closed: full width");
	rmSync(dir, { recursive: true, force: true });
});

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
import { DocPanelController, KEYS, resolveDocPath } from "../index.ts";
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

test("show opens one non-capturing right-hand overlay, and a second show swaps the doc", async () => {
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

	await controller.show(ui, join(dir, "b.md"));
	assert.equal(state.shown, 1, "swapped in place, not a second overlay");
	assert.match(state.component!.render(100).join("\n"), /Beta/);
	assert.match(state.component!.render(100)[0]!, /b\.md/);

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

test("toggle hides with a badge, shows again, and reopens the last doc after close", async () => {
	resetForTests();
	const dir = scratch();
	writeFileSync(join(dir, "a.md"), "# Alpha\n");
	const { ui, state } = fakeUi();
	const controller = new DocPanelController();
	await controller.show(ui, join(dir, "a.md"));
	await tick();

	controller.focus();
	assert.equal(state.focused, true);
	state.component!.handleInput!("\x1b");
	assert.equal(state.focused, false, "Esc gives focus back");
	assert.equal(state.hidden, false, "Esc does not close or hide");

	await controller.toggle(ui);
	assert.equal(state.hidden, true);
	assert.deepEqual(
		snapshot().find((g) => g.source === "doc-panel")?.badges.map((b) => b.text),
		["doc", `a.md · ${KEYS.toggle}`],
	);
	assert.match(state.status ?? "", /hidden/, "no badge renderer in tests, so the footer says it");

	controller.focus();
	assert.equal(state.hidden, false, "focusing a hidden panel shows it");
	assert.equal(snapshot().find((g) => g.source === "doc-panel"), undefined);
	assert.equal(state.status, undefined);

	controller.close();
	await controller.toggle(ui);
	await tick();
	assert.equal(state.shown, 2, "toggle with nothing open reopens the last doc");
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

	await controller.toggle(ui);
	assert.equal(state.hidden, true);
	assert.deepEqual(tui.render(120), ["120"], "hidden: full width");

	await controller.toggle(ui);
	assert.deepEqual(tui.render(120), ["60"]);

	controller.close();
	assert.deepEqual(tui.render(120), ["120"], "closed: full width");
	rmSync(dir, { recursive: true, force: true });
});

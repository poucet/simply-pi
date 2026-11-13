/**
 * The side-pane registry, and the subagent chat sitting beside the doc panel
 * rather than over or under it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { besideSidePane } from "../chat-view.ts";
import { notify, publish, reservedRight, resetForTests, subscribe } from "../../shared/side-pane.ts";
import { copyToSystemClipboard } from "../../shared/mouse-selection.ts";

test("nothing published reserves nothing; a reserve is read on every ask", () => {
	resetForTests();
	assert.equal(reservedRight(120), 0);
	let shown = true;
	publish("doc-panel", (columns) => (shown ? Math.floor(columns / 2) : 0));
	assert.equal(reservedRight(120), 60);
	assert.equal(reservedRight(80), 40, "a resize needs no republishing");
	shown = false;
	assert.equal(reservedRight(120), 0, "nor does hiding");
	publish("doc-panel", undefined);
	assert.equal(reservedRight(120), 0);
	resetForTests();
});

test("reserves add up, never take every column, and a broken one counts as none", () => {
	resetForTests();
	publish("a", () => 30);
	publish("b", () => {
		throw new Error("boom");
	});
	publish("c", () => Number.NaN);
	assert.equal(reservedRight(100), 30);
	publish("d", () => 500);
	assert.equal(reservedRight(100), 99, "one column always stays");
	resetForTests();
});

test("subscribers hear publish, withdraw and notify, and a broken one does not silence the rest", () => {
	resetForTests();
	let heard = 0;
	subscribe(() => {
		throw new Error("broken");
	});
	const off = subscribe(() => heard++);
	publish("p", () => 10);
	notify();
	publish("p", undefined);
	publish("p", undefined); // nothing to withdraw: no news
	assert.equal(heard, 3);
	off();
	notify();
	assert.equal(heard, 3);
	resetForTests();
});

test("the subagent chat overlay runs from the left edge to the doc panel, and redraws when the panel changes", () => {
	resetForTests();
	let renders = 0;
	const tui: any = { terminal: { columns: 120, rows: 30 }, requestRender: () => renders++ };
	const layout = besideSidePane();
	const detach = layout.attach(tui);
	assert.equal(layout.options.anchor, "top-left");
	assert.equal(layout.options.width, 120, "the full width with no panel");
	let reserve = 50;
	publish("doc-panel", () => reserve);
	assert.equal(layout.options.width, 70, "beside the panel");
	assert.equal(renders, 1, "the panel showing draws a frame");
	reserve = 0;
	notify();
	assert.equal(layout.options.width, 120, "hidden: the full width again");
	assert.equal(renders, 2);
	tui.terminal.columns = 100;
	reserve = 40;
	assert.equal(layout.options.width, 60, "a resize is read on the next frame");
	detach();
	notify();
	assert.equal(renders, 2, "detached on close");
	resetForTests();
});

test("a copy goes through pi's clipboard path and says so in the flash; a failure flashes its message", async () => {
	const flashes: Array<[string, number | undefined]> = [];
	const tui = { flash: (m: string, d?: number) => flashes.push([m, d]) };
	const got: string[] = [];
	assert.equal(await copyToSystemClipboard(tui, "hi", async (t) => void got.push(t)), true);
	assert.deepEqual(got, ["hi"]);
	assert.deepEqual(flashes, [["Copied!", undefined]]);
	assert.equal(
		await copyToSystemClipboard(tui, "x", async () => {
			throw new Error("no clipboard");
		}),
		false,
	);
	assert.deepEqual(flashes.at(-1), ["no clipboard", 5000]);
	assert.equal(await copyToSystemClipboard({}, "y", async () => {}), true, "no flash in regular mode is fine");
	assert.equal(await copyToSystemClipboard(tui, "", async () => assert.fail("empty is not copied")), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { type HistoryPeek, moveToLineEnd, peekHistory, shouldHoldDown } from "../history-guard.ts";

const at = (over: Partial<HistoryPeek> = {}): HistoryPeek => ({
	index: 0,
	draftEmpty: true,
	onLastVisualLine: true,
	...over,
});
const hold = (history: HistoryPeek | undefined, over: { textEmpty?: boolean; autocompleteOpen?: boolean } = {}) =>
	shouldHoldDown({ textEmpty: false, autocompleteOpen: false, history, ...over });

test("down is held only where it would swap text for an empty draft", () => {
	assert.equal(hold(at()), true);
});

test("down steps freely between history entries", () => {
	assert.equal(hold(at({ index: 1 })), false);
	assert.equal(hold(at({ index: 5 })), false);
});

test("down returns freely to a draft that has text", () => {
	assert.equal(hold(at({ draftEmpty: false })), false);
});

test("down above the last line is cursor movement, never held", () => {
	assert.equal(hold(at({ onLastVisualLine: false })), false);
});

test("not browsing history: nothing to hold", () => {
	assert.equal(hold(at({ index: -1 })), false);
});

test("an empty box or an open autocomplete list is never held", () => {
	assert.equal(hold(at(), { textEmpty: true }), false);
	assert.equal(hold(at(), { autocompleteOpen: true }), false);
});

test("unknown history state means stock behaviour", () => {
	assert.equal(hold(undefined), false);
});

test("peekHistory answers don't-know when the private fields are missing", () => {
	assert.equal(peekHistory({}), undefined);
	assert.equal(peekHistory(null), undefined);
	assert.equal(peekHistory({ historyIndex: 0, historyDraft: null }), undefined);
	assert.equal(peekHistory({ historyIndex: "0", historyDraft: null, isOnLastVisualLine: () => true }), undefined);
	assert.equal(peekHistory({ historyIndex: 0, historyDraft: { other: 1 }, isOnLastVisualLine: () => true }), undefined);
	assert.equal(
		peekHistory({
			historyIndex: 0,
			historyDraft: null,
			isOnLastVisualLine: () => {
				throw new Error("renamed internals");
			},
		}),
		undefined,
	);
});

test("peekHistory reads the draft the way the editor restores it", () => {
	const fields = (historyDraft: unknown) => ({ historyIndex: 0, historyDraft, isOnLastVisualLine: () => true });
	assert.deepEqual(peekHistory(fields(null)), at());
	assert.deepEqual(peekHistory(fields({ lines: [""] })), at());
	assert.deepEqual(peekHistory(fields({ lines: ["typed"] })), at({ draftEmpty: false }));
	assert.deepEqual(peekHistory(fields({ lines: ["", ""] })), at({ draftEmpty: false }));
});

test("moveToLineEnd reports false when the method is gone", () => {
	assert.equal(moveToLineEnd({}), false);
	let called = 0;
	assert.equal(
		moveToLineEnd({
			moveToLineEnd() {
				called++;
			},
		}),
		true,
	);
	assert.equal(called, 1);
});

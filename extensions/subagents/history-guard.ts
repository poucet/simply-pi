/**
 * `↓` never empties the input box.
 *
 * pi's editor treats `↓` on the last visual line as "next history entry" while a
 * recalled prompt is showing. Stepping past the newest entry restores the draft
 * that was in the box when browsing began, and when that draft was empty, which
 * is the usual case (an empty box, `↑` to recall, `↓` to read to the bottom), one
 * press too many wipes the prompt. Clearing has its own key, `app.clear`
 * (ctrl+c), so `↓` is kept to navigation: at that one step it moves the cursor to
 * the end of the line instead, which is what it does on the last line of any
 * box that is not browsing history.
 *
 * Everything else is untouched: stepping between history entries, and back to a
 * draft that has text in it, behaves exactly as stock.
 *
 * The editor exposes none of the history state publicly, so `peekHistory` reads
 * the base class's private fields. That reach is confined to the two helpers
 * below, and both answer "don't know" when the fields are not what they expect,
 * so a pi upgrade that renames them degrades to stock behaviour, never a throw.
 */

/** What the editor's history browsing would do on the next forward step. */
export interface HistoryPeek {
	/** -1 when not browsing, 0 for the newest entry, counting up into the past. */
	index: number;
	/** Whether the draft that a step past the newest entry restores is empty. */
	draftEmpty: boolean;
	/** Whether the cursor is on the last visual line, where `↓` steps history. */
	onLastVisualLine: boolean;
}

/**
 * Should this `↓` be kept from stepping history?
 *
 * True only when the step would replace text with an empty box: browsing at the
 * newest entry, on the last line, with an empty draft behind it. An open
 * autocomplete list owns `↓`, and `undefined` history (fields not found) means
 * stock behaviour.
 */
export function shouldHoldDown(input: {
	textEmpty: boolean;
	autocompleteOpen: boolean;
	history: HistoryPeek | undefined;
}): boolean {
	const { history } = input;
	if (history === undefined || input.textEmpty || input.autocompleteOpen) return false;
	return history.index === 0 && history.onLastVisualLine && history.draftEmpty;
}

/**
 * The base editor's private members this module reads, all `unknown` because
 * none of them is a contract: each is checked before use. Parameters are typed
 * `unknown` rather than this, since TypeScript will not let a class instance
 * stand in for a type that names its private members as public.
 */
interface PrivateEditorFields {
	historyIndex?: unknown;
	historyDraft?: unknown;
	isOnLastVisualLine?: unknown;
	moveToLineEnd?: unknown;
}

/** Read the editor's private history state, or `undefined` if it is not there. */
export function peekHistory(editor: unknown): HistoryPeek | undefined {
	try {
		if (typeof editor !== "object" || editor === null) return undefined;
		const e = editor as PrivateEditorFields;
		if (typeof e.historyIndex !== "number") return undefined;
		if (!("historyDraft" in e)) return undefined;
		if (typeof e.isOnLastVisualLine !== "function") return undefined;
		const draftEmpty = isEmptyDraft(e.historyDraft);
		if (draftEmpty === undefined) return undefined;
		const onLastVisualLine = (e.isOnLastVisualLine as () => unknown).call(editor);
		if (typeof onLastVisualLine !== "boolean") return undefined;
		return { index: e.historyIndex, draftEmpty, onLastVisualLine };
	} catch {
		return undefined;
	}
}

/**
 * Move the cursor to the end of its line, as `↓` does on the last line outside
 * history browsing. False when the method is not there, so the caller can fall
 * back to stock behaviour.
 */
export function moveToLineEnd(editor: unknown): boolean {
	if (typeof editor !== "object" || editor === null) return false;
	const move = (editor as PrivateEditorFields).moveToLineEnd;
	if (typeof move !== "function") return false;
	move.call(editor);
	return true;
}

/**
 * The editor restores a `null` draft as an empty box, and otherwise the saved
 * state, whose `lines` is `[""]` when it was empty.
 */
function isEmptyDraft(draft: unknown): boolean | undefined {
	if (draft === null || draft === undefined) return true;
	const lines = (draft as { lines?: unknown }).lines;
	if (!Array.isArray(lines)) return undefined;
	return lines.length === 0 || (lines.length === 1 && lines[0] === "");
}

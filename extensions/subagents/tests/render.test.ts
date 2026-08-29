import assert from "node:assert/strict";
import { test } from "node:test";
import {
	COLLAPSED_TEXT_LINES,
	DEFAULT_EXPAND_HINT,
	type RenderTheme,
	clipText,
	formatSubagentCall,
	formatSubagentResult,
	renderSubagentCall,
	renderSubagentResult,
	resultText,
	shortenCwd,
} from "../render.ts";

/**
 * Themes that keep the colour choice visible in the assertion.
 *
 * `plain` is for shape assertions; `tagged` proves a fragment went through the
 * right theme slot rather than a hardcoded escape sequence.
 */
const plain: RenderTheme = { fg: (_c, t) => t, bold: (t) => t };
const tagged: RenderTheme = { fg: (c, t) => `[${c}]${t}[/${c}]`, bold: (t) => `*${t}*` };

const call = (args: any, expanded = false, theme: RenderTheme = plain) =>
	formatSubagentCall(args, theme, { expanded, expandHint: DEFAULT_EXPAND_HINT });
const result = (res: any, args: any, opts: any = {}, theme: RenderTheme = plain) =>
	formatSubagentResult(res, args, theme, { expandHint: DEFAULT_EXPAND_HINT, ...opts });

// ------------------------------------------------------------------ helpers ---

test("clipText clips by line budget and reports it", () => {
	const text = "a\nb\nc\nd\ne";
	assert.deepEqual(clipText(text, 3, 999), { text: "a\nb\nc", clipped: true });
	assert.deepEqual(clipText("a\nb", 3, 999), { text: "a\nb", clipped: false });
});

test("clipText clips by character budget for one long paragraph", () => {
	const clipped = clipText("x".repeat(500), 3, 100);
	assert.equal(clipped.text.length, 100);
	assert.equal(clipped.clipped, true);
});

test("shortenCwd collapses the home prefix but leaves other paths alone", () => {
	assert.equal(shortenCwd("/Users/me/work", "/Users/me"), "~/work");
	assert.equal(shortenCwd("/Users/me", "/Users/me"), "~");
	assert.equal(shortenCwd("/opt/other", "/Users/me"), "/opt/other");
	assert.equal(shortenCwd("/Users/melon/x", "/Users/me"), "/Users/melon/x");
});

test("resultText joins the text parts and ignores the rest", () => {
	assert.equal(
		resultText({ content: [{ type: "text", text: " a " }, { type: "image" } as any, { type: "text", text: "b" }] }),
		"a \nb",
	);
	assert.equal(resultText(undefined), "");
});

// -------------------------------------------------------------- renderCall ---

test("renderCall names the action for every action the tool accepts", () => {
	const actions = [
		"spawn",
		"message",
		"followup",
		"list",
		"read",
		"notes",
		"interrupt",
		"answer",
		"retry",
		"close",
	];
	for (const action of actions) {
		const text = call({ action, name: "worker", task: "t", message: "m" });
		assert.ok(text.startsWith("subagent "), `${action}: missing tool name`);
		assert.ok(text.includes(action), `${action}: action not shown`);
	}
});

test("renderCall spawn shows name, persona, model, context, tools and cwd", () => {
	const text = call({
		action: "spawn",
		name: "render",
		persona: "reviewer",
		model: "anthropic/claude-sonnet-4-5",
		context: "forked",
		tools: ["read", "bash"],
		cwd: "/tmp/wt",
		task: "Fix the renderer",
	});
	assert.match(text, /subagent spawn "render"/);
	assert.match(text, /persona reviewer/);
	assert.match(text, /anthropic\/claude-sonnet-4-5/);
	assert.match(text, /forked context/);
	assert.match(text, /tools: read, bash/);
	assert.match(text, /in \/tmp\/wt/);
});

test("renderCall spawn shows the task text — the whole point of the row", () => {
	const text = call({ action: "spawn", name: "w", task: "Refactor the parser\nand add tests" });
	assert.match(text, /task:/);
	assert.match(text, /Refactor the parser/);
	assert.match(text, /and add tests/);
});

test("renderCall spawn clips a long task when collapsed and offers the hint", () => {
	const task = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const collapsed = call({ action: "spawn", name: "w", task });
	assert.match(collapsed, /line 0/);
	assert.ok(!collapsed.includes("line 19"), "collapsed row must not contain the whole task");
	assert.match(collapsed, new RegExp(`${20 - COLLAPSED_TEXT_LINES} more lines`));
	assert.match(collapsed, /to expand/);
});

test("renderCall spawn shows the task unabridged when expanded", () => {
	const task = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const expanded = call({ action: "spawn", name: "w", task }, true);
	for (let i = 0; i < 20; i += 1) assert.match(expanded, new RegExp(`line ${i}\\b`));
	assert.ok(!expanded.includes("to expand"), "expanded row must not offer to expand");
});

test("renderCall spawn flags a missing task as an error", () => {
	assert.match(call({ action: "spawn", name: "w" }, false, tagged), /\[error\]\(no task\)/);
});

test("renderCall followup/message/answer show the target and the message text", () => {
	for (const action of ["followup", "message", "answer"]) {
		const text = call({ action, name: "worker", message: "please rerun the tests" });
		assert.match(text, /worker/);
		assert.match(text, /please rerun the tests/, `${action}: message text missing`);
	}
});

test("renderCall read/close/interrupt show the target", () => {
	for (const action of ["read", "close", "interrupt"]) {
		assert.match(call({ action, name: "worker" }), /worker/, `${action}: target missing`);
	}
});

test("renderCall notes distinguishes read from append and shows appended text", () => {
	assert.match(call({ action: "notes" }), /notes read/);
	const append = call({ action: "notes", notes_action: "append", message: "decision X" });
	assert.match(append, /notes append/);
	assert.match(append, /decision X/);
});

test("renderCall uses theme slots and never raw colour codes", () => {
	const text = call({ action: "spawn", name: "w", task: "do it", cwd: "/tmp" }, false, tagged);
	assert.match(text, /\[toolTitle\]\*subagent\*\[\/toolTitle\]/);
	assert.match(text, /\[accent\]spawn\[\/accent\]/);
	assert.match(text, /\[toolOutput\]do it\[\/toolOutput\]/);
	assert.ok(!/\u001b\[/.test(text), "no hardcoded escape sequences");
});

test("renderCall tolerates junk arguments", () => {
	assert.doesNotThrow(() => call({}));
	assert.doesNotThrow(() => call({ action: "spawn", name: 42, task: null, names: [1, 2] }));
	assert.match(call({ action: "not_an_action" }), /not_an_action/);
});

// ------------------------------------------------------------ renderResult ---

test("renderResult spawn digests name, context mode and cwd", () => {
	const text = result(
		{ content: [{ type: "text", text: "Spawned…" }], details: { agent: "render", contextMode: "forked", cwd: "/tmp/wt" } },
		{ action: "spawn" },
	);
	assert.match(text, /spawned/);
	assert.match(text, /render/);
	assert.match(text, /forked context/);
	assert.match(text, /\/tmp\/wt/);
});

test("renderResult spawn warns when another agent was reclaimed", () => {
	const text = result(
		{ details: { agent: "b", reclaimed: "a" } },
		{ action: "spawn" },
		{},
		tagged,
	);
	assert.match(text, /\[warning\]closed "a" to free a slot/);
});

test("renderResult read leads with the agent status and clips the body", () => {
	const output = Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n");
	const res = { content: [{ type: "text", text: output }], details: { agent: "w", status: "completed" } };
	const collapsed = result(res, { action: "read" });
	assert.match(collapsed, /w \[completed\]/);
	assert.match(collapsed, /out 0/);
	assert.ok(!collapsed.includes("out 29"));
	assert.match(collapsed, /more lines/);

	const expanded = result(res, { action: "read" }, { expanded: true });
	assert.match(expanded, /out 29/);
	assert.ok(!expanded.includes("more lines"));
});

test("renderResult list counts the agents", () => {
	assert.match(result({ details: { agents: [{ name: "a" }, { name: "b" }] } }, { action: "list" }), /2 subagents/);
	assert.match(result({ details: { agents: [] } }, { action: "list" }), /no subagents/);
});

test("renderResult answer reports the fallback path honestly", () => {
	assert.match(
		result({ details: { agent: "w", delivered: false } }, { action: "answer" }, {}, tagged),
		/\[warning\]"w" had no question outstanding/,
	);
	assert.match(result({ details: { agent: "w", delivered: true } }, { action: "answer" }), /answered/);
});

test("renderResult keeps errors in the error slot and does not clip them", () => {
	const text = result(
		{ isError: true, content: [{ type: "text", text: 'unknown persona "nope".\nAvailable: reviewer' }] },
		{ action: "spawn" },
		{},
		tagged,
	);
	assert.match(text, /^\[error\]/);
	assert.match(text, /unknown persona "nope"/);
	assert.match(text, /Available: reviewer/);
});

test("renderResult shows streamed progress verbatim while partial", () => {
	const text = result(
		{ content: [{ type: "text", text: "render: summarizing parent context (42 messages)" }] },
		{ action: "spawn" },
		{ isPartial: true },
		tagged,
	);
	assert.match(text, /\[warning\]render: summarizing parent context \(42 messages\)/);
});

test("renderResult falls back to the tool's own one-liner for simple actions", () => {
	assert.match(
		result({ content: [{ type: "text", text: 'Delivered to "w".' }] }, { action: "followup" }),
		/Delivered to "w"\./,
	);
	assert.match(result({}, { action: "close" }), /done/);
});

// -------------------------------------------------------------- components ---

test("renderSubagentCall returns a Text component and reuses lastComponent", () => {
	const first = renderSubagentCall({ action: "list" }, plain, {});
	assert.equal(typeof (first as any).setText, "function");
	const second = renderSubagentCall({ action: "spawn", name: "w", task: "t" }, plain, {
		lastComponent: first,
	});
	assert.equal(second, first, "the same component instance must be updated in place");
});

test("renderSubagentResult reads args from the render context, not from state", () => {
	const component = renderSubagentResult(
		{ details: { agent: "w", contextMode: "fresh", cwd: "/tmp" } },
		{ expanded: false, isPartial: false },
		plain,
		{ args: { action: "spawn" } },
	);
	assert.match(String((component as any).text ?? ""), /spawned/);
});

test("the component wrappers survive missing args and context", () => {
	assert.doesNotThrow(() => renderSubagentCall(undefined, plain, undefined));
	assert.doesNotThrow(() => renderSubagentResult(undefined, undefined, plain, undefined));
});

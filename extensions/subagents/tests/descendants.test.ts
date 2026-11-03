/**
 * Agents below our own children: tree placement, session-file tailing, the
 * widget's indented rows, the strip's order, and the read-only transcript pane.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ChatPaneRegistry } from "../chat-pane.ts";
import { SubagentChatView, switcherLines } from "../chat-view.ts";
import {
	DescendantTracker,
	applySessionEntries,
	descendantTree,
	emptyStats,
} from "../descendants.ts";
import type { RegistryNode } from "../registry.ts";
import { SessionFileTail } from "../session-log.ts";
import { MAIN_ENTRY_ID, SwitcherStrip, nestedEntryId, stripEntries, treeEntries } from "../switcher.ts";
import type { ChatHost, DescendantView, ManagedAgent } from "../types.ts";

const plain: any = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `[${text}]`,
	bold: (text: string) => text,
};

function node(sessionId: string, parentSessionId: string | undefined, extra: Partial<RegistryNode> = {}): RegistryNode {
	return {
		sessionId,
		...(parentSessionId ? { parentSessionId } : {}),
		name: sessionId,
		status: "running",
		lastActiveAt: 1,
		...extra,
	};
}

function view(sessionId: string, depth: number, extra: Partial<DescendantView> = {}): DescendantView {
	return {
		sessionId,
		parentSessionId: "p",
		parentName: "lead",
		name: sessionId,
		status: "running",
		icon: "◐",
		depth,
		startedAt: Date.now() - 120_000,
		turns: 5,
		cost: 0.08,
		activity: `doing ${sessionId}`,
		...extra,
	};
}

function agent(id: string, name: string, sessionId = `s-${id}`): ManagedAgent {
	return {
		id,
		sessionId,
		name,
		task: "task",
		cwd: "/tmp",
		sessionFile: `/tmp/does-not-exist-${id}.jsonl`,
		status: "running",
		contextMode: "fresh",
		usage: { cost: 0.31, turns: 12 },
		activity: [{ at: 0, text: "running tests" }],
		startedAt: Date.now() - 240_000,
	} as unknown as ManagedAgent;
}

function host(agents: ManagedAgent[], below: Record<string, DescendantView[]>, sent: string[] = []): ChatHost {
	return {
		agents: () => agents,
		unread: () => 0,
		statusIcon: () => "◐",
		subscribe: () => () => {},
		send: async (_id, text) => {
			sent.push(text);
		},
		descendants: (a) => below[a.id] ?? [],
	};
}

// ---------------------------------------------------------------- tree ----

test("descendants are placed depth first, each parent before its children", () => {
	const nodes = [
		node("child", "root"),
		node("b", "child", { startedAt: 20 }),
		node("a", "child", { startedAt: 10 }),
		node("a1", "a"),
		node("a1x", "a1"),
		node("elsewhere", "other-root"),
	];
	const placed = descendantTree(nodes, "child");
	assert.deepEqual(
		placed.map((p) => [p.node.sessionId, p.depth]),
		[
			["a", 1],
			["a1", 2],
			["a1x", 3],
			["b", 1],
		],
	);
});

test("closed descendants drop out with their subtree, and cycles terminate", () => {
	const nodes = [
		node("a", "child", { status: "closed" }),
		node("a1", "a"),
		node("x", "child"),
		node("y", "x"),
		{ ...node("x", "y"), sessionId: "x2", parentSessionId: "y" },
		node("child", "x"), // claims to be its own grandchild's child
	];
	const placed = descendantTree(nodes, "child");
	assert.deepEqual(
		placed.map((p) => p.node.sessionId),
		["x", "y", "x2"],
	);
});

// ------------------------------------------------------------- tailing ----

test("the tail reads only appended bytes and holds back a half-written line", () => {
	const dir = mkdtempSync(join(tmpdir(), "tail-"));
	const file = join(dir, "session.jsonl");
	const tail = new SessionFileTail(file);
	assert.deepEqual(tail.read(), { entries: [], reset: false }, "a missing file is nothing new");

	writeFileSync(file, `${JSON.stringify({ type: "session", n: 1 })}\n{"type":"mess`);
	assert.deepEqual(tail.read().entries, [{ type: "session", n: 1 }]);
	assert.deepEqual(tail.read().entries, [], "unchanged file: nothing");

	appendFileSync(file, `age","n":2}\nnot json\n${JSON.stringify({ type: "x", text: "é" })}\n`);
	assert.deepEqual(tail.read().entries, [{ type: "message", n: 2 }, { type: "x", text: "é" }]);

	writeFileSync(file, `${JSON.stringify({ type: "fresh" })}\n`);
	const after = tail.read();
	assert.equal(after.reset, true, "a shorter file is a replaced file");
	assert.deepEqual(after.entries, [{ type: "fresh" }]);
});

test("the tail reads only the new bytes, not the whole file again", () => {
	let positions: number[] = [];
	let content = Buffer.from('{"a":1}\n');
	const fs = {
		statSync: () => ({ size: content.length }),
		openSync: () => 3,
		readSync: (_fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
			positions.push(position);
			return content.copy(buffer, offset, position, position + length);
		},
		closeSync: () => {},
	};
	const tail = new SessionFileTail("/virtual", fs);
	tail.read();
	positions = [];
	content = Buffer.concat([content, Buffer.from('{"b":2}\n')]);
	assert.deepEqual(tail.read().entries, [{ b: 2 }]);
	assert.deepEqual(positions, [8]);
});

test("session entries fold into turns, cost and latest activity, skipping inherited messages", () => {
	const since = Date.parse("2026-01-01T00:00:00Z");
	const stats = applySessionEntries(emptyStats(), [
		{ type: "session", timestamp: "2026-01-01T00:00:00Z" },
		// Copied from the parent by a forked spawn: older than the header.
		{ type: "message", message: { role: "assistant", timestamp: since - 5, usage: { cost: { total: 9 } }, content: [] } },
		{ type: "message", message: { role: "user", content: "go" } },
		{
			type: "message",
			message: {
				role: "assistant",
				timestamp: since + 1,
				usage: { cost: { total: 0.05 } },
				content: [{ type: "toolCall", name: "edit", id: "t", arguments: { path: "rpc.ts" } }],
			},
		},
		{
			type: "message",
			message: { role: "assistant", timestamp: since + 2, usage: { cost: { total: 0.03 } }, content: [{ type: "text", text: "done\nmore" }] },
		},
	]);
	assert.equal(stats.turns, 2);
	assert.ok(Math.abs(stats.cost - 0.08) < 1e-9);
	assert.equal(stats.activity, "done");
	assert.equal(stats.lastAt, since + 2);
});

test("the tracker builds rows from the registry and the files, and stays quiet without children", () => {
	const dir = mkdtempSync(join(tmpdir(), "tracker-"));
	const registryFile = join(dir, "registry.json");
	writeFileSync(registryFile, "{}");
	const sessionFile = join(dir, "g.jsonl");
	writeFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }] },
		})}\n`,
	);
	let reads = 0;
	let changes = 0;
	let roots = [{ sessionId: "child", name: "lead" }];
	const tracker = new DescendantTracker({
		registryFile: () => registryFile,
		readNodes: () => {
			reads += 1;
			return [
				node("g", "child", { name: "coder-a", sessionFile, pid: 111 }),
				node("gg", "g", { name: "deep", pid: 222, status: "completed", usage: { turns: 3, cost: 0.5 } as any }),
			];
		},
		roots: () => roots,
		icon: (status) => (status === "running" ? "◐" : "✓"),
		onChange: () => {
			changes += 1;
		},
		alive: (pid) => pid === 111,
	});
	tracker.poll();
	const rows = tracker.of("child");
	assert.deepEqual(
		rows.map((r) => [r.name, r.depth, r.status, r.parentName, r.turns, r.activity]),
		[
			["coder-a", 1, "running", "lead", 1, "$ npm test"],
			// Dead pid: hibernated, and the registry's usage stands in for a missing file.
			["deep", 2, "hibernated", "coder-a", 3, ""],
		],
	);
	assert.equal(changes, 1);
	tracker.poll();
	assert.equal(reads, 1, "an unchanged registry is not re-read");
	assert.equal(changes, 1, "nothing changed, nothing repainted");

	roots = [];
	tracker.poll();
	assert.deepEqual(tracker.of("child"), []);
	tracker.stop();
});

// -------------------------------------------------------------- widget ----

test("the widget draws descendants indented under their parent; only children are numbered", () => {
	const agents = [agent("a", "lead"), agent("b", "reviewer")];
	const h = host(agents, { a: [view("coder-a", 1), view("deep", 2), view("coder-b", 1)] });
	const strip = new SwitcherStrip(h, { requestRender() {}, open() {} });
	const lines = switcherLines(h, plain, strip);
	assert.match(lines[0]!, /^  1 ◐ lead 4m00s 12t \$0\.31  running tests$/);
	assert.match(lines[1]!, /^    └ ◐ coder-a 2m00s 5t \$0\.08  doing coder-a$/);
	assert.match(lines[2]!, /^      └ ◐ deep /, "depth 2 sits two further in");
	assert.match(lines[3]!, /^    └ ◐ coder-b /);
	assert.match(lines[4]!, /^  2 ◐ reviewer /);
});

test("the strip lists descendants after their parent, in tree order", () => {
	const agents = [agent("a", "lead"), agent("b", "reviewer")];
	const h = host(agents, { a: [view("g1", 1), view("g2", 2)] });
	assert.deepEqual(
		stripEntries(h).map((e) => [e.id, e.icon + e.label]),
		[
			[MAIN_ENTRY_ID, "●main"],
			["a", "◐lead"],
			[nestedEntryId("g1"), "└◐g1"],
			[nestedEntryId("g2"), "└◐g2"],
			["b", "◐reviewer"],
		],
	);
	assert.deepEqual(
		treeEntries(h).map((e) => (e.kind === "agent" ? e.number : e.kind)),
		[1, "nested", "nested", 2],
	);
});

// --------------------------------------------------------- read-only pane ----

test("a descendant opens as a read-only transcript with no input box", () => {
	// Message components draw with pi's global theme.
	initTheme();
	const dir = mkdtempSync(join(tmpdir(), "transcript-"));
	const sessionFile = join(dir, "s.jsonl");
	writeFileSync(sessionFile, "");
	const sent: string[] = [];
	let renders = 0;
	const tui: any = {
		requestRender() {
			renders += 1;
		},
		terminal: { rows: 24, columns: 80 },
	};
	const h = host([agent("a", "lead")], { a: [view("coder-a", 1, { sessionFile })] }, sent);
	const registry = new ChatPaneRegistry(tui, h.subscribe, () => {});
	const v = new SubagentChatView(tui, plain, h, registry, () => {}, nestedEntryId("coder-a"));

	const frame = v.render(80);
	assert.match(frame[0]!, /coder-a .*read-only · spawned by lead/);
	const notice = frame.find((line) => line.includes("read-only transcript"));
	assert.ok(notice, "the pane says it is read-only");
	assert.match(notice!, /message it through lead/);
	assert.ok(!frame.some((line) => line.includes("enter send")), "no send hint");

	for (const key of ["h", "i", "\r"]) v.handleInput(key);
	assert.deepEqual(sent, [], "typing reaches nobody");
	assert.ok(!v.render(80).some((line) => line.includes(" hi")), "and is not echoed into an editor");

	// The file grows; a tick picks it up.
	appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "user", content: "fix the parser" } })}\n`);
	renders = 0;
	v.tick();
	assert.equal(renders, 1);
	assert.ok(v.render(80).some((line) => line.includes("fix the parser")));
	v.tick();
	assert.equal(renders, 1, "an unchanged file repaints nothing");
});

test("a direct child still opens with its input box", () => {
	const tui: any = { requestRender() {}, terminal: { rows: 24, columns: 80 } };
	const h = host([agent("a", "lead")], { a: [view("coder-a", 1)] });
	const registry = new ChatPaneRegistry(tui, h.subscribe, () => {});
	const v = new SubagentChatView(tui, plain, h, registry, () => {}, "a");
	const frame = v.render(80);
	assert.ok(!frame.some((line) => line.includes("read-only")));
	assert.ok(frame.some((line) => line.includes("enter send")));
});

/**
 * The boot flag, and what it is (and is not) allowed to suppress.
 *
 * Children run with **normal extension discovery** — a subagent should be the
 * same agent as you, elsewhere — so this extension is loaded inside them too.
 *
 * The guard has to run inside the extension factory, *before* any session
 * exists, so it genuinely cannot consult the session: it gets one bit,
 * `PI_SUBAGENT=1`, and no identity at all. Real identity (which agent am I,
 * whose child am I) lives in the session header; see identity.ts.
 *
 * What the bit suppresses is deliberately narrow. It skips the **UI** — widget,
 * editor component, footer status, `/agents` — because a child has no terminal
 * of its own. It does **not** skip the tool: subagents may spawn subagents, so
 * removing `subagent` would enforce a policy that was explicitly rejected.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import childExtension from "../child-extension.ts";
import { PARENT_SESSION_ENV, SUBAGENT_BOOT_ENV, isSubagentBoot } from "../identity.ts";
import subagents from "../index.ts";

/** Records everything an extension tries to register. */
function spy() {
	const registered = {
		tools: [] as string[],
		commands: [] as string[],
		shortcuts: [] as string[],
		events: [] as string[],
	};
	const pi: any = {
		registerTool: (tool: any) => registered.tools.push(tool.name),
		registerCommand: (name: string) => registered.commands.push(name),
		registerShortcut: (key: string) => registered.shortcuts.push(key),
		on: (event: string) => registered.events.push(event),
		sendMessage: () => {},
		appendEntry: () => {},
	};
	return { pi, registered };
}

/** Run `body` with a specific subagent environment, restoring it afterwards. */
function withEnv(env: Record<string, string | undefined>, body: () => void) {
	const keys = [
		"PI_SUBAGENT",
		"PI_SUBAGENT_NAME",
		"PI_SUBAGENT_PARENT",
		"PI_SUBAGENT_NOTES",
		"PI_SUBAGENT_ANSWERS",
		"PI_SUBAGENT_MCP",
	];
	const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	try {
		for (const key of keys) {
			const value = env[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		body();
	} finally {
		for (const key of keys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// --- the parent side ------------------------------------------------------

test("outside a child, the extension registers its whole surface", () => {
	const { pi, registered } = spy();
	withEnv({}, () => subagents(pi));
	assert.ok(registered.tools.includes("subagent"));
	assert.ok(registered.commands.includes("agents"));
	assert.ok(registered.events.includes("session_start"));
});

test("inside a child, the UI is suppressed but the tool is not", () => {
	const { pi, registered } = spy();
	withEnv({ [SUBAGENT_BOOT_ENV]: "1" }, () => subagents(pi));
	// The tool survives: a subagent may delegate in turn.
	assert.ok(registered.tools.includes("subagent"));
	// The UI does not: a child has no terminal of its own to paint into.
	assert.deepEqual(registered.commands, []);
	assert.deepEqual(registered.shortcuts, []);
});

test("a child still wires its lifecycle, so its own children are tracked", () => {
	const { pi, registered } = spy();
	withEnv({ [SUBAGENT_BOOT_ENV]: "1" }, () => subagents(pi));
	// Without these a nested agent could spawn children that nothing records —
	// the exact stranding the registry exists to prevent.
	assert.ok(registered.events.includes("session_start"));
	assert.ok(registered.events.includes("session_shutdown"));
});

test("the boot flag is one bit and carries no identity", () => {
	// Every shape of child environment produces the same suppression, because the
	// guard reads the flag and nothing else. Anything that wants to know *which*
	// agent this is has to ask the session.
	for (const env of [
		{ [SUBAGENT_BOOT_ENV]: "1" },
		{ [SUBAGENT_BOOT_ENV]: "1", PI_SUBAGENT_NAME: "worker" },
		{ [SUBAGENT_BOOT_ENV]: "1", [PARENT_SESSION_ENV]: "parent-uuid" },
		{ [SUBAGENT_BOOT_ENV]: "1", PI_SUBAGENT_NOTES: "/n", PI_SUBAGENT_ANSWERS: "/a" },
	]) {
		const { pi, registered } = spy();
		withEnv(env, () => subagents(pi));
		assert.deepEqual(registered.commands, [], JSON.stringify(env));
		assert.ok(registered.tools.includes("subagent"), JSON.stringify(env));
	}
});

test("a child started by an older parent still suppresses its UI", () => {
	// `PI_SUBAGENT_NAME` alone is what the previous scheme set. A child launched
	// by a parent that predates the boot flag must not suddenly start painting.
	const { pi, registered } = spy();
	withEnv({ PI_SUBAGENT_NAME: "worker" }, () => subagents(pi));
	assert.deepEqual(registered.commands, []);
});

test("isSubagentBoot reads the flag, not an identity", () => {
	assert.equal(isSubagentBoot({}), false);
	assert.equal(isSubagentBoot({ [SUBAGENT_BOOT_ENV]: "1" }), true);
	// A falsy-looking value is not a subagent: `PI_SUBAGENT=0` in a shell profile
	// should mean "no", not "yes, because the variable is present".
	assert.equal(isSubagentBoot({ [SUBAGENT_BOOT_ENV]: "0" }), false);
	assert.equal(isSubagentBoot({ [SUBAGENT_BOOT_ENV]: "" }), false);
	assert.equal(isSubagentBoot({ [SUBAGENT_BOOT_ENV]: "false" }), false);
	// Nothing about *which* agent is derivable from it.
	assert.equal(isSubagentBoot({ [PARENT_SESSION_ENV]: "parent-uuid" }), false);
});

// --- the child side -------------------------------------------------------

test("a child always gets report_to_parent", () => {
	const { pi, registered } = spy();
	withEnv({ [SUBAGENT_BOOT_ENV]: "1", PI_SUBAGENT_NAME: "worker" }, () => childExtension(pi));
	assert.deepEqual(registered.tools, ["report_to_parent"]);
});

test("shared_notes and ask_parent appear only when their paths are configured", () => {
	const { pi, registered } = spy();
	withEnv(
		{ PI_SUBAGENT_NAME: "worker", PI_SUBAGENT_NOTES: "/n/NOTES.md", PI_SUBAGENT_ANSWERS: "/a" },
		() => childExtension(pi),
	);
	assert.deepEqual([...registered.tools].sort(), ["ask_parent", "report_to_parent", "shared_notes"]);
});

test("without an answers directory a child cannot ask, and does not pretend it can", () => {
	// Offering a tool that would block forever is worse than not offering it.
	const { pi, registered } = spy();
	withEnv({ PI_SUBAGENT_NAME: "worker", PI_SUBAGENT_NOTES: "/n" }, () => childExtension(pi));
	assert.ok(!registered.tools.includes("ask_parent"));
	assert.ok(registered.tools.includes("shared_notes"));
});

// --- MCP ------------------------------------------------------------------

test("the MCP extension itself has no subagent-specific behaviour", async () => {
	// MCP is kept out of children by the denylist (it is simply never passed
	// with -e), not by a guard inside it. That keeps the policy in one place and
	// works identically for extensions we do not control.
	const mcpSource = readFileSync(
		new URL("../../mcp/index.ts", import.meta.url),
		"utf-8",
	);
	assert.ok(
		!mcpSource.includes("PI_SUBAGENT"),
		"the denylist is the mechanism; mcp/index.ts should not special-case subagents",
	);
});

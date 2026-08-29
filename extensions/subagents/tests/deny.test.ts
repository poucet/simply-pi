/**
 * The child extension denylist.
 *
 * Children inherit the parent's auto-discovered extensions; this is the one
 * place exceptions are expressed. The matching rules matter more than they look:
 * a mistyped entry denies *nothing*, which is a silent way to get more than you
 * asked for, so the unmatched-entry reporting is part of the contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_CHILD_DENY,
	denyMatches,
	extensionName,
	parseDenyList,
	partitionExtensions,
} from "../deny.ts";

const USER = "/home/me/.pi/agent/extensions";

// --- naming ---------------------------------------------------------------

test("an extension's name is its file stem, or its directory for index files", () => {
	assert.equal(extensionName(`${USER}/model-routing.ts`), "model-routing");
	assert.equal(extensionName(`${USER}/mcp/index.ts`), "mcp");
	// Not "index": that is the file, not the extension.
	assert.notEqual(extensionName(`${USER}/mcp/index.ts`), "index");
	assert.equal(extensionName(`${USER}/thing.mjs`), "thing");
});

// --- matching -------------------------------------------------------------

test("a plain name matches both layouts", () => {
	assert.equal(denyMatches("mcp", `${USER}/mcp/index.ts`), true);
	assert.equal(denyMatches("slack-approval", `${USER}/slack-approval.ts`), true);
});

test("matching is case-insensitive", () => {
	assert.equal(denyMatches("MCP", `${USER}/mcp/index.ts`), true);
	assert.equal(denyMatches("Slack-Approval", `${USER}/slack-approval.ts`), true);
});

test("an entry written with its file extension still matches", () => {
	assert.equal(denyMatches("slack-approval.ts", `${USER}/slack-approval.ts`), true);
	assert.equal(denyMatches("mcp/", `${USER}/mcp/index.ts`), true);
});

test("an absolute path matches that exact extension only", () => {
	assert.equal(denyMatches(`${USER}/mcp/index.ts`, `${USER}/mcp/index.ts`), true);
	// Two extensions can share a name in different directories; a path keeps
	// them separable where a plain name would not.
	assert.equal(denyMatches(`${USER}/mcp/index.ts`, "/other/place/mcp/index.ts"), false);
	assert.equal(denyMatches("mcp", "/other/place/mcp/index.ts"), true);
});

test("a path with .. or a trailing slash still resolves to the same extension", () => {
	assert.equal(denyMatches(`${USER}/sub/../mcp/index.ts`, `${USER}/mcp/index.ts`), true);
});

test("near-misses do not match", () => {
	assert.equal(denyMatches("mc", `${USER}/mcp/index.ts`), false);
	assert.equal(denyMatches("mcp-extra", `${USER}/mcp/index.ts`), false);
	assert.equal(denyMatches("", `${USER}/mcp/index.ts`), false);
	assert.equal(denyMatches("   ", `${USER}/mcp/index.ts`), false);
});

// --- partitioning ---------------------------------------------------------

const discovered = [
	`${USER}/mcp/index.ts`,
	`${USER}/mistral-logo.ts`,
	`${USER}/model-routing.ts`,
	`${USER}/slack-approval.ts`,
	`${USER}/subagents/index.ts`,
];

test("the default denylist keeps providers and mcp, and drops the dialog extension", () => {
	const result = partitionExtensions(discovered, DEFAULT_CHILD_DENY, [`${USER}/subagents/index.ts`]);
	// model-routing is the one that must survive: without it a child cannot
	// authenticate at all. `mcp` now survives too — its cost is controlled by
	// scoping which servers a child boots (shared/mcp-scope.ts), not by refusing
	// the extension, which also refused the child that genuinely needed one server.
	assert.deepEqual(result.allowed, [
		`${USER}/mcp/index.ts`,
		`${USER}/mistral-logo.ts`,
		`${USER}/model-routing.ts`,
	]);
	assert.deepEqual(
		result.denied.map((d) => extensionName(d.path)).sort(),
		["slack-approval", "subagents"],
	);
	assert.deepEqual(result.unmatched, []);
});

test("denying mcp by hand still works, and is stronger than an empty scope", () => {
	// The escape hatch has to keep working: an empty MCP scope starves the
	// extension of servers, but denying it stops it loading at all.
	const result = partitionExtensions(discovered, ["mcp"], [`${USER}/subagents/index.ts`]);
	assert.ok(!result.allowed.includes(`${USER}/mcp/index.ts`));
	assert.equal(result.denied.find((d) => extensionName(d.path) === "mcp")?.entry, "mcp");
});

test("the subagents extension is always denied, whatever the denylist says", () => {
	// Emptying the denylist must not be a way to get grandchildren.
	const result = partitionExtensions(discovered, [], [`${USER}/subagents/index.ts`]);
	assert.ok(!result.allowed.includes(`${USER}/subagents/index.ts`));
	assert.equal(result.denied.find((d) => extensionName(d.path) === "subagents")?.entry, "(always)");
	// Everything else is inherited.
	assert.equal(result.allowed.length, 4);
});

test("self-denial matches by name even from a different checkout", () => {
	// The parent may be running from a worktree while discovery finds the
	// symlinked copy; the same extension must still not be inherited.
	const result = partitionExtensions(
		[`${USER}/subagents/index.ts`],
		[],
		["/somewhere/else/subagents/index.ts"],
	);
	assert.deepEqual(result.allowed, []);
});

test("an unmatched entry is reported rather than silently doing nothing", () => {
	const result = partitionExtensions(discovered, ["mcp", "typo-here", "  "], []);
	// The typo denied nothing, so the child inherits what you meant to exclude.
	assert.deepEqual(result.unmatched, ["typo-here"]);
	assert.ok(result.allowed.includes(`${USER}/slack-approval.ts`));
});

test("an entry that matches several extensions is used, not reported unmatched", () => {
	const result = partitionExtensions(
		[`${USER}/mcp/index.ts`, "/project/.pi/extensions/mcp/index.ts"],
		["mcp"],
		[],
	);
	assert.deepEqual(result.allowed, []);
	assert.deepEqual(result.unmatched, []);
});

test("discovery order is preserved for the survivors", () => {
	const result = partitionExtensions(discovered, ["mcp"], []);
	assert.deepEqual(result.allowed, [
		`${USER}/mistral-logo.ts`,
		`${USER}/model-routing.ts`,
		`${USER}/slack-approval.ts`,
		`${USER}/subagents/index.ts`,
	]);
});

// --- the setting ----------------------------------------------------------

test("a missing or malformed childDeny falls back to the defaults", () => {
	assert.deepEqual(parseDenyList(undefined), DEFAULT_CHILD_DENY);
	assert.deepEqual(parseDenyList("mcp"), DEFAULT_CHILD_DENY);
	assert.deepEqual(parseDenyList(null), DEFAULT_CHILD_DENY);
});

test("an explicit empty list means deny nothing", () => {
	// Distinct from "missing": the user has said what they want.
	assert.deepEqual(parseDenyList([]), []);
});

test("entries are trimmed and non-strings dropped", () => {
	assert.deepEqual(parseDenyList([" mcp ", 42, "", "  ", "slack-approval"]), [
		"mcp",
		"slack-approval",
	]);
});

test("the default list is exactly the dialog problem", () => {
	// slack-approval is not a preference: any dialog-opening extension hangs a
	// child, because ChildRpc does not answer extension_ui_request yet.
	//
	// `mcp` is deliberately *not* here any more. Denying it was a cost control
	// aimed at ~90 tools booting in every child, and it worked by also denying the
	// child that wanted one server. The cost is now controlled by the per-child
	// server allowlist, which defaults to empty — so an unconfigured install still
	// boots nothing, and this list only carries the problem that scoping cannot fix.
	assert.deepEqual(DEFAULT_CHILD_DENY, ["slack-approval"]);
});

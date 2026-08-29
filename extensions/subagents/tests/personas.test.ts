import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describePersonas, discoverPersonas, findPersona, parseContextMode, parseToolList } from "../personas.ts";

// --- parseToolList --------------------------------------------------------

test("parseToolList reads a comma-separated string", () => {
	assert.deepEqual(parseToolList("read, bash ,grep"), ["read", "bash", "grep"]);
});

test("parseToolList reads a YAML sequence", () => {
	assert.deepEqual(parseToolList(["read", " bash "]), ["read", "bash"]);
});

test("parseToolList drops empties and non-strings", () => {
	assert.deepEqual(parseToolList(["read", "", 3, null]), ["read"]);
	assert.equal(parseToolList(""), undefined);
	assert.equal(parseToolList(" , "), undefined);
	assert.equal(parseToolList(undefined), undefined);
	assert.equal(parseToolList(42), undefined);
});

test("parseToolList: a star means inherit everything", () => {
	// pi's `--tools` is a literal name allowlist, so a "*" that reached it would
	// strip the child's tools instead of granting them (the Claude Code convention).
	assert.equal(parseToolList(["*"]), undefined);
	assert.equal(parseToolList("*"), undefined);
	// Names alongside a star are ignored: the star already granted them.
	assert.equal(parseToolList(["read", "*", "bash"]), undefined);
	assert.equal(parseToolList("read, *"), undefined);
});

// --- parseContextMode -----------------------------------------------------

test("parseContextMode accepts the four valid values", () => {
	for (const mode of ["auto", "fresh", "forked", "compacted"] as const) {
		assert.equal(parseContextMode(mode), mode);
	}
});

test("parseContextMode rejects anything else rather than throwing", () => {
	// A bad frontmatter key must not brick the persona it sits in.
	assert.equal(parseContextMode("Fresh"), undefined);
	assert.equal(parseContextMode("fork"), undefined);
	assert.equal(parseContextMode("compacted, forked"), undefined);
	assert.equal(parseContextMode(""), undefined);
	assert.equal(parseContextMode("auto".repeat(2)), undefined);
	assert.equal(parseContextMode(42), undefined);
	assert.equal(parseContextMode(["fresh"]), undefined);
	assert.equal(parseContextMode(undefined), undefined);
});

// --- discovery ------------------------------------------------------------

function persona(body: string): string {
	return body;
}

test("discoverPersonas reads user personas and honours project trust", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-personas-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(join(project, ".pi", "agents"), { recursive: true });

	writeFileSync(
		join(agentDir, "agents", "reviewer.md"),
		persona("---\nname: reviewer\ndescription: reviews diffs\ntools: read, bash\nmodel: x/y\ncontext: forked\n---\nBe strict.\n"),
	);
	// Bad frontmatter keys are skipped, not fatal.
	writeFileSync(
		join(agentDir, "agents", "typist.md"),
		persona('---\nname: typist\ncontext: Forked\ntools: ["*"]\n---\nType.\n'),
	);
	// No frontmatter name: the filename wins.
	writeFileSync(join(agentDir, "agents", "scout.md"), persona("Scout the code.\n"));
	// Empty body: not a persona.
	writeFileSync(join(agentDir, "agents", "blank.md"), persona("---\nname: blank\n---\n\n"));
	// Not markdown: ignored.
	writeFileSync(join(agentDir, "agents", "notes.txt"), persona("nope"));
	writeFileSync(
		join(project, ".pi", "agents", "reviewer.md"),
		persona("---\nname: reviewer\ndescription: project override\n---\nProject rules.\n"),
	);

	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const userOnly = discoverPersonas(project, false);
		assert.deepEqual(
			userOnly.map((p) => p.name).sort(),
			["reviewer", "scout", "typist"],
		);
		const reviewer = findPersona(userOnly, "REVIEWER");
		assert.equal(reviewer?.source, "user");
		assert.deepEqual(reviewer?.tools, ["read", "bash"]);
		assert.equal(reviewer?.model, "x/y");
		assert.equal(reviewer?.context, "forked");
		assert.match(reviewer!.systemPrompt, /Be strict/);
		assert.equal(findPersona(userOnly, "scout")?.description, "");
		// Mistyped context falls through to undefined; a star in tools means inherit all.
		const typist = findPersona(userOnly, "typist");
		assert.equal(typist?.context, undefined);
		assert.equal(typist?.tools, undefined);

		// Trusted project: the project persona wins over the user one.
		const withProject = discoverPersonas(join(project, "nested", "deeper"), true);
		const overridden = findPersona(withProject, "reviewer");
		assert.equal(overridden?.source, "project");
		assert.equal(overridden?.description, "project override");
		// No context key in the project override: absent is undefined, not "auto".
		assert.equal(overridden?.context, undefined);

		assert.match(describePersonas(userOnly), /reviewer — reviews diffs/);
		assert.equal(describePersonas([]), "none");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverPersonas returns nothing when the user directory is absent", () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-personas-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "missing");
	try {
		assert.deepEqual(discoverPersonas(root, true), []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

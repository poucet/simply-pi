import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_TIMEOUT_SECONDS, guardBashInput } from "../../shell-guard/index.ts";

test("guardBashInput forces non-interactive editors and a default timeout", () => {
	const input: { command: string; timeout?: number } = { command: "jj squash" };
	guardBashInput(input);
	assert.match(input.command, /^export .*JJ_EDITOR=true.*\njj squash$/);
	assert.match(input.command, /GIT_EDITOR=true/);
	assert.equal(input.timeout, DEFAULT_TIMEOUT_SECONDS);
});

test("guardBashInput keeps an explicit timeout and is idempotent", () => {
	const input = { command: "ls", timeout: 5 };
	guardBashInput(input);
	const once = input.command;
	guardBashInput(input);
	assert.equal(input.command, once);
	assert.equal(input.timeout, 5);
});

test("a message-less git commit returns under the guard instead of opening vim", () => {
	const dir = mkdtempSync(join(tmpdir(), "shell-guard-"));
	try {
		const input = {
			command: "git init -q . && git -c user.name=t -c user.email=t@t commit -q --allow-empty; echo done",
		};
		guardBashInput(input);
		const out = execFileSync("bash", ["-c", input.command], {
			cwd: dir,
			env: { ...process.env, EDITOR: "vim", VISUAL: "vim", GIT_EDITOR: "vim" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20_000,
		}).toString();
		assert.match(out, /done/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

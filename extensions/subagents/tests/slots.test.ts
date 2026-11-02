/**
 * The process-slot cap: its configuration, and holding it under concurrency.
 *
 * The concurrency tests exist because the cap used to be checked and then
 * honoured several awaits later. Spawns issued as parallel tool calls in one
 * batch all checked the same table, all saw room, and all got in — eleven
 * children running under a cap of six.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DEFAULT_MAX_OPEN_AGENTS,
	MAX_OPEN_AGENTS_CEILING,
	SubagentManager,
	parseMaxOpenAgents,
} from "../manager.ts";
import { emptyUsage } from "../types.ts";

// --- configuration -----------------------------------------------------------

test("maxOpenAgents defaults to 10 when absent, silently", () => {
	assert.equal(DEFAULT_MAX_OPEN_AGENTS, 10);
	assert.deepEqual(parseMaxOpenAgents(undefined), { value: DEFAULT_MAX_OPEN_AGENTS });
});

test("maxOpenAgents accepts whole numbers from 1 to the ceiling", () => {
	assert.deepEqual(parseMaxOpenAgents(1), { value: 1 });
	assert.deepEqual(parseMaxOpenAgents(16), { value: 16 });
	assert.deepEqual(parseMaxOpenAgents(MAX_OPEN_AGENTS_CEILING), { value: MAX_OPEN_AGENTS_CEILING });
});

test("a bad maxOpenAgents falls back to the default and says why", () => {
	for (const bad of [0, -3, 2.5, MAX_OPEN_AGENTS_CEILING + 1, "12", null, Number.NaN, Infinity]) {
		const parsed = parseMaxOpenAgents(bad);
		assert.equal(parsed.value, DEFAULT_MAX_OPEN_AGENTS, `value for ${String(bad)}`);
		assert.match(parsed.problem ?? "", /maxOpenAgents must be a whole number/, `problem for ${String(bad)}`);
	}
});

test("the manager enforces the configured cap, not a constant", () => {
	const callbacks = { onChange: () => {}, onMail: () => {} };
	assert.equal(new SubagentManager(callbacks, {}).maxOpenAgents, DEFAULT_MAX_OPEN_AGENTS);
	assert.equal(new SubagentManager(callbacks, { maxOpenAgents: 3 }).maxOpenAgents, 3);
	assert.equal(new SubagentManager(callbacks, { maxOpenAgents: 0 }).maxOpenAgents, DEFAULT_MAX_OPEN_AGENTS);
	const m = new SubagentManager(callbacks, {});
	m.setConfig({ maxOpenAgents: 4 });
	assert.equal(m.maxOpenAgents, 4, "a settings reload takes effect");
});

// --- concurrency -------------------------------------------------------------

/** Resolves once, when the test says so. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { opened, open };
}

/**
 * A manager whose extension discovery waits on a gate.
 *
 * Discovery is one of the awaits between the cap check and the moment a new
 * agent registers, so holding it open holds every admitted spawn in exactly the
 * window the race lived in. `inFlight` counts how many got that far.
 */
class GatedManager extends SubagentManager {
	inFlight = 0;
	peakInFlight = 0;
	discovery = gate();
	protected override async resolveChildExtensions(): Promise<string[]> {
		this.inFlight += 1;
		this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
		await this.discovery.opened;
		this.inFlight -= 1;
		return [];
	}
}

function harness(maxOpenAgents: number) {
	const home = mkdtempSync(join(tmpdir(), "subagent-slots-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousBin = process.env.PI_SUBAGENT_BIN;
	process.env.PI_CODING_AGENT_DIR = home;
	// A child that exits at once: every admitted spawn fails at launch, after the
	// region under test, and leaves no process behind.
	const stub = join(home, "dead-child.sh");
	writeFileSync(stub, "#!/bin/sh\nexit 1\n");
	chmodSync(stub, 0o755);
	process.env.PI_SUBAGENT_BIN = stub;
	const m = new GatedManager({ onChange: () => {}, onMail: () => {} }, { maxOpenAgents });
	const ctx: any = {
		cwd: home,
		sessionManager: {
			getSessionId: () => "parent-session",
			getSessionFile: () => join(home, "parent.jsonl"),
			getEntries: () => [],
			getLeafId: () => "leaf-1",
		},
	};
	return {
		m,
		ctx,
		home,
		restore() {
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			if (previousBin === undefined) delete process.env.PI_SUBAGENT_BIN;
			else process.env.PI_SUBAGENT_BIN = previousBin;
		},
	};
}

/** Settle every promise, keeping the rejection messages. */
function outcomes(promises: Promise<unknown>[]): Promise<string[]> {
	return Promise.all(
		promises.map((p) =>
			p.then(
				() => "ok",
				(error: Error) => error.message,
			),
		),
	);
}

/** Let every spawn run up to its first real wait (discovery, or a refusal). */
async function settleSync(m: GatedManager, expected: number): Promise<void> {
	for (let i = 0; i < 200 && m.inFlight < expected; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("parallel spawns cannot all pass the cap check before any registers", async () => {
	const N = 3;
	const k = 4;
	const h = harness(N);
	try {
		const spawns = Array.from({ length: N + k }, (_, i) =>
			h.m.spawn(h.ctx, [], { name: `w${i}`, task: "t", context: "fresh" }),
		);
		const settled = outcomes(spawns);
		await settleSync(h.m, N);
		// Give any spawn that wrongly got through time to reach discovery too.
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(h.m.inFlight, N, "exactly the cap's worth are admitted");
		h.m.discovery.open();
		const results = await settled;
		const refused = results.filter((r) => /too many open subagents \(3\/3\)/.test(r));
		assert.equal(refused.length, k, `the other ${k} are refused: ${JSON.stringify(results)}`);
		assert.ok(h.m.peakInFlight <= N, `never more than ${N} at once (saw ${h.m.peakInFlight})`);
		// Every admitted spawn failed at launch and gave its slot back.
		assert.equal(h.m.openCount, 0);
		assert.equal(h.m.maxOpenAgents, N);
	} finally {
		h.restore();
	}
});

test("a slot freed by a failed spawn is usable again", async () => {
	const h = harness(1);
	try {
		h.m.discovery.open();
		const first = await outcomes([h.m.spawn(h.ctx, [], { name: "a", task: "t", context: "fresh" })]);
		assert.match(first[0]!, /failed to start subagent/);
		const second = await outcomes([h.m.spawn(h.ctx, [], { name: "b", task: "t", context: "fresh" })]);
		assert.match(second[0]!, /failed to start subagent/, "not refused for a leaked reservation");
	} finally {
		h.restore();
	}
});

test("parallel revives of hibernated children respect the cap too", async () => {
	const N = 2;
	const h = harness(N);
	try {
		// Hibernated children hold no slot; reviving one makes it hold one again,
		// several awaits after the check — the same window as a spawn.
		for (let i = 0; i < N + 2; i += 1) {
			const dir = join(h.home, `child-${i}`);
			mkdirSync(dir);
			const sessionFile = join(dir, "session.jsonl");
			writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 1 })}\n`);
			h.m.restore([
				{
					id: `c${i}`,
					name: `c${i}`,
					task: "t",
					cwd: dir,
					contextMode: "fresh",
					status: "completed",
					sessionFile,
					sessionDir: dir,
					startedAt: 0,
					usage: { ...emptyUsage() },
					output: "",
					launch: { notesPath: join(dir, "NOTES.md"), extensions: [] },
				} as any,
			]);
		}
		assert.equal(h.m.openCount, 0);
		const revives = Array.from({ length: N + 2 }, (_, i) => h.m.revive(`c${i}`));
		const settled = outcomes(revives);
		await new Promise((resolve) => setTimeout(resolve, 50));
		h.m.discovery.open();
		const results = await settled;
		const refused = results.filter((r) => /too many open subagents/.test(r));
		assert.equal(refused.length, 2, `two are refused: ${JSON.stringify(results)}`);
		assert.equal(h.m.openCount, 0, "the admitted ones failed at launch and hold nothing");
	} finally {
		h.restore();
	}
});

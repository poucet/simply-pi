import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSpawnStage, progressReporter } from "../progress.ts";
import { SummaryCache } from "../summary-cache.ts";

// -------------------------------------------------------------- the cache ---

test("a second spawn from the same leaf reuses the summary", async () => {
	const cache = new SummaryCache();
	let calls = 0;
	const compute = async () => {
		calls += 1;
		return `summary ${calls}`;
	};

	assert.equal(await cache.get("leaf-1", compute), "summary 1");
	assert.equal(await cache.get("leaf-1", compute), "summary 1");
	assert.equal(await cache.get("leaf-1", compute), "summary 1");
	assert.equal(calls, 1, "three spawns from one conversation point must summarize once");
});

test("a fan-out issued back to back shares the in-flight call", async () => {
	const cache = new SummaryCache();
	let calls = 0;
	let release: (value: string) => void = () => {};
	const compute = () => {
		calls += 1;
		return new Promise<string>((resolve) => {
			release = resolve;
		});
	};

	// The common shape: spawn, spawn, spawn with no await in between.
	const all = Promise.all([
		cache.get("leaf-1", compute),
		cache.get("leaf-1", compute),
		cache.get("leaf-1", compute),
	]);
	assert.equal(calls, 1, "concurrent spawns must not race to compute the same summary");
	release("shared");
	assert.deepEqual(await all, ["shared", "shared", "shared"]);
});

test("the cache misses once the parent leaf moves", async () => {
	const cache = new SummaryCache();
	let calls = 0;
	const compute = async () => `summary ${(calls += 1)}`;

	assert.equal(await cache.get("leaf-1", compute), "summary 1");
	assert.equal(await cache.get("leaf-2", compute), "summary 2");
	assert.equal(calls, 2);
	// The old leaf is not kept: only the newest conversation point is worth a slot.
	assert.equal(await cache.get("leaf-1", compute), "summary 3");
	assert.equal(calls, 3);
});

test("has() reports whether a spawn would be served without summarizing", async () => {
	const cache = new SummaryCache();
	assert.equal(cache.has("leaf-1"), false);
	await cache.get("leaf-1", async () => "s");
	assert.equal(cache.has("leaf-1"), true);
	assert.equal(cache.has("leaf-2"), false);
	assert.equal(cache.has(null), false);
	assert.equal(cache.has(undefined), false);
	assert.equal(cache.has(""), false);
});

test("a missing leaf id is never cached", async () => {
	const cache = new SummaryCache();
	let calls = 0;
	const compute = async () => `s${(calls += 1)}`;
	assert.equal(await cache.get(null, compute), "s1");
	assert.equal(await cache.get(null, compute), "s2");
	assert.equal(await cache.get("", compute), "s3");
	assert.equal(calls, 3, "without a leaf identity there is nothing to invalidate against");
});

test("a failed summarization is not remembered", async () => {
	const cache = new SummaryCache();
	let calls = 0;
	const compute = async () => {
		calls += 1;
		if (calls === 1) throw new Error("provider is down");
		return "recovered";
	};

	await assert.rejects(() => cache.get("leaf-1", compute), /provider is down/);
	assert.equal(cache.has("leaf-1"), false);
	assert.equal(await cache.get("leaf-1", compute), "recovered");
	assert.equal(calls, 2);
});

test("a failure does not evict a newer leaf's entry", async () => {
	const cache = new SummaryCache();
	let fail: (error: Error) => void = () => {};
	const failing = cache.get("leaf-1", () => new Promise<string>((_r, reject) => { fail = reject; }));
	failing.catch(() => {});

	await cache.get("leaf-2", async () => "good");
	fail(new Error("late failure"));
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(cache.has("leaf-2"), true, "the late failure of an old leaf must not clear leaf-2");
});

test("clear() forgets everything", async () => {
	const cache = new SummaryCache();
	await cache.get("leaf-1", async () => "s");
	cache.clear();
	assert.equal(cache.has("leaf-1"), false);
});

// ------------------------------------------------------------- progress ---

test("every spawn stage names what is happening", () => {
	assert.match(describeSpawnStage({ stage: "context", name: "w" }), /reading parent context/);
	assert.match(
		describeSpawnStage({ stage: "summarizing", name: "w", messages: 42 }),
		/summarizing parent context \(42 messages\)/,
	);
	assert.match(
		describeSpawnStage({ stage: "summarizing", name: "w", messages: 1 }),
		/\(1 message\)/,
	);
	assert.match(describeSpawnStage({ stage: "summarizing", name: "w" }), /summarizing parent context$/);
	assert.match(describeSpawnStage({ stage: "summary-cached", name: "w" }), /reusing the parent context summary/);
	assert.match(describeSpawnStage({ stage: "seeding", name: "w", mode: "forked" }), /seeding child session \(forked context\)/);
	assert.match(describeSpawnStage({ stage: "seeding", name: "w" }), /seeding child session$/);
	assert.match(describeSpawnStage({ stage: "starting", name: "w" }), /starting child process/);
	assert.match(describeSpawnStage({ stage: "accepted", name: "w" }), /child accepted the task/);
});

test("every stage is prefixed with the agent name", () => {
	const stages = ["context", "summarizing", "summary-cached", "seeding", "starting", "accepted"] as const;
	for (const stage of stages) {
		assert.match(describeSpawnStage({ stage, name: "render" }), /^render: /, stage);
	}
});

test("progressReporter emits well-formed partial tool results", () => {
	const seen: any[] = [];
	const report = progressReporter((partial) => seen.push(partial));
	report({ stage: "starting", name: "w" });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].content[0].type, "text");
	assert.match(seen[0].content[0].text, /starting child process/);
	assert.deepEqual(seen[0].details, { agent: "w", stage: "starting" });
});

test("progressReporter is a no-op without onUpdate and swallows UI failures", () => {
	assert.doesNotThrow(() => progressReporter(undefined)({ stage: "context", name: "w" }));
	const throwing = progressReporter(() => {
		throw new Error("the TUI is gone");
	});
	assert.doesNotThrow(() => throwing({ stage: "context", name: "w" }));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTO_FORK_CONTEXT_FRACTION,
	AUTO_FORK_MESSAGE_LIMIT,
	contextUsage,
	forkableMessages,
	isUnsafeThinkingBlock,
	resolveMode,
	sanitizeInheritedMessage,
} from "../context.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const assistantCall = (...ids: string[]) => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall", id, name: "subagent" })),
});
const toolResult = (toolCallId: string) => ({ role: "toolResult", toolCallId });

test("forkableMessages keeps a conversation with no trailing tool call", () => {
	const messages = [user("hi"), assistantText("hello")];
	assert.deepEqual(forkableMessages(messages), messages);
});

test("forkableMessages keeps an empty conversation", () => {
	assert.deepEqual(forkableMessages([]), []);
});

test("forkableMessages trims the assistant message whose tool call is unresolved", () => {
	// This is the spawn case: we are running inside the tool call itself.
	const messages = [user("hi"), assistantCall("call-1")];
	assert.deepEqual(forkableMessages(messages), [messages[0]]);
});

test("forkableMessages keeps an assistant message whose tool calls all resolved", () => {
	const messages = [user("hi"), assistantCall("call-1"), toolResult("call-1")];
	assert.deepEqual(forkableMessages(messages), messages);
});

test("forkableMessages trims when only some tool calls resolved", () => {
	const messages = [user("hi"), assistantCall("call-1", "call-2"), toolResult("call-2")];
	assert.deepEqual(forkableMessages(messages), [messages[0]]);
});

test("forkableMessages trims a tool call with a missing id", () => {
	const messages = [user("hi"), { role: "assistant", content: [{ type: "toolCall" }] }];
	assert.deepEqual(forkableMessages(messages), [messages[0]]);
});

test("forkableMessages ignores non-message junk before the last assistant turn", () => {
	const messages = [assistantText("older"), user("hi")];
	assert.deepEqual(forkableMessages(messages), messages);
});

test("resolveMode passes explicit modes through", () => {
	for (const mode of ["fresh", "forked", "compacted"] as const) {
		assert.equal(resolveMode(mode, 0), mode);
		assert.equal(resolveMode(mode, 500), mode);
	}
});

test("resolveMode auto: empty parent conversation means fresh", () => {
	assert.equal(resolveMode("auto", 0), "fresh");
});

test("resolveMode auto with no token estimate falls back to the message limit", () => {
	// Deliberately generous: forking is free and lossless, so it stays the default
	// until a copy plausibly would not fit. Only reached when getContextUsage() has
	// nothing to say (before the first response, or just after a compaction).
	assert.equal(resolveMode("auto", 1), "forked");
	assert.equal(resolveMode("auto", 14), "forked", "14 messages is a short conversation");
	assert.equal(resolveMode("auto", AUTO_FORK_MESSAGE_LIMIT), "forked");
	assert.equal(resolveMode("auto", AUTO_FORK_MESSAGE_LIMIT + 1), "compacted");
});

test("resolveMode auto decides on tokens when an estimate is available", () => {
	const window = 200_000;
	const threshold = window * AUTO_FORK_CONTEXT_FRACTION;
	const usage = (tokens: number | null) => ({ tokens, contextWindow: window });

	assert.equal(resolveMode("auto", 500, usage(1_000)), "forked", "many small messages fit");
	assert.equal(resolveMode("auto", 500, usage(threshold)), "forked", "exactly at the limit");
	assert.equal(resolveMode("auto", 3, usage(threshold + 1)), "compacted", "a few huge messages");
	assert.equal(resolveMode("auto", 3, usage(window)), "compacted");
});

test("resolveMode auto ignores an unusable token estimate", () => {
	// tokens is null right after a compaction; contextWindow 0 means we were told
	// nothing useful. Either way the message-count rule must take over.
	assert.equal(resolveMode("auto", 3, { tokens: null, contextWindow: 200_000 }), "forked");
	assert.equal(resolveMode("auto", 3, { tokens: 1_000_000, contextWindow: 0 }), "forked");
	assert.equal(resolveMode("auto", 500, { tokens: null, contextWindow: 200_000 }), "compacted");
});

test("resolveMode auto: an empty conversation is fresh regardless of tokens", () => {
	assert.equal(resolveMode("auto", 0, { tokens: 999_999, contextWindow: 1 }), "fresh");
});

test("resolveMode honours explicit modes even against the token rule", () => {
	const huge = { tokens: 1_000_000, contextWindow: 200_000 };
	assert.equal(resolveMode("forked", 500, huge), "forked");
	assert.equal(resolveMode("fresh", 0, huge), "fresh");
});

test("contextUsage tolerates a host that cannot report usage", () => {
	assert.equal(contextUsage({}), undefined);
	assert.equal(contextUsage(undefined), undefined);
	assert.equal(
		contextUsage({
			getContextUsage() {
				throw new Error("no session");
			},
		}),
		undefined,
	);
	assert.equal(contextUsage({ getContextUsage: () => undefined }), undefined);
	assert.equal(contextUsage({ getContextUsage: () => ({ tokens: 5 }) }), undefined);
	assert.deepEqual(contextUsage({ getContextUsage: () => ({ tokens: 5, contextWindow: 10 }) }), {
		tokens: 5,
		contextWindow: 10,
	});
});

// --- signed thinking blocks must not cross into a child session -----------
//
// Anthropic signs extended-thinking blocks over the request that produced them,
// and pi-ai passes the signature straight back (anthropic-messages.js: the
// `thinking`/`redacted_thinking` branch of the assistant-message conversion).
// A forked child is a different session, a different message list and possibly
// a different model, so those signatures are meaningless there.

const anthropic = (content: any[]) => ({
	role: "assistant",
	provider: "anthropic",
	api: "anthropic-messages",
	model: "claude-sonnet-4-5",
	content,
});

test("a signed thinking block is stripped from an inherited message", () => {
	const message = anthropic([
		{ type: "thinking", thinking: "secret reasoning", thinkingSignature: "sig-abc" },
		{ type: "text", text: "the answer is 4" },
	]);
	const sanitized = sanitizeInheritedMessage(message);
	assert.deepEqual(sanitized.content, [{ type: "text", text: "the answer is 4" }]);
	assert.equal(message.content.length, 2, "the parent's own message is not mutated");
});

test("the legacy `signature` spelling is stripped too", () => {
	// Anthropic's wire name, in case a message reaches us before pi-ai renames it.
	const message = anthropic([{ type: "thinking", thinking: "hmm", signature: "sig-abc" }]);
	assert.deepEqual(sanitizeInheritedMessage(message).content, []);
});

test("a redacted_thinking block is always stripped", () => {
	// The opaque encrypted payload is worthless outside its own conversation, and
	// it is stripped regardless of who we think produced the message.
	assert.deepEqual(
		sanitizeInheritedMessage({
			role: "assistant",
			content: [{ type: "redacted_thinking", data: "EncryptedBlob" }, { type: "text", text: "ok" }],
		}).content,
		[{ type: "text", text: "ok" }],
	);
	// pi-ai's in-memory shape for the same thing.
	assert.deepEqual(
		sanitizeInheritedMessage(
			anthropic([{ type: "thinking", thinking: "", thinkingSignature: "blob", redacted: true }]),
		).content,
		[],
	);
});

test("an unsigned thinking block passes through", () => {
	// Nothing to verify, so nothing to reject; and it is the readable part.
	const message = anthropic([
		{ type: "thinking", thinking: "visible reasoning" },
		{ type: "text", text: "done" },
	]);
	assert.equal(sanitizeInheritedMessage(message), message, "unchanged messages are not copied");
	assert.deepEqual(
		sanitizeInheritedMessage(anthropic([{ type: "thinking", thinking: "x", thinkingSignature: "" }]))
			.content,
		[{ type: "thinking", thinking: "x", thinkingSignature: "" }],
	);
});

test("a signed thinking block from a provider that does not verify is kept", () => {
	for (const provider of ["google", "openai", "mistral"]) {
		const message = {
			role: "assistant",
			provider,
			api: provider === "openai" ? "openai-responses" : provider,
			content: [{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig" }],
		};
		assert.equal(sanitizeInheritedMessage(message), message, `${provider} should be untouched`);
	}
});

test("an unrecognised or missing provider fails closed", () => {
	// Being wrong here costs a forked child some reasoning text. Being wrong the
	// other way costs it a 400 on its first turn.
	for (const message of [
		{ role: "assistant", content: [{ type: "thinking", thinking: "r", thinkingSignature: "s" }] },
		{
			role: "assistant",
			provider: "some-new-gateway",
			api: "unknown",
			content: [{ type: "thinking", thinking: "r", thinkingSignature: "s" }],
		},
		{
			role: "assistant",
			provider: "amazon-bedrock",
			api: "bedrock-converse-stream",
			content: [{ type: "thinking", thinking: "r", thinkingSignature: "s" }],
		},
	]) {
		assert.deepEqual(sanitizeInheritedMessage(message).content, [], JSON.stringify(message.provider));
	}
});

test("sanitizing leaves non-assistant messages and odd shapes alone", () => {
	for (const message of [
		user("hi"),
		toolResult("call-1"),
		{ role: "assistant", content: "plain string content" },
		{ role: "assistant" },
		undefined,
		null,
	]) {
		assert.equal(sanitizeInheritedMessage(message), message);
	}
});

test("isUnsafeThinkingBlock ignores blocks that are not thinking", () => {
	const message = anthropic([]);
	for (const block of [
		{ type: "text", text: "hello" },
		{ type: "toolCall", id: "1", name: "read" },
		{ type: "image", data: "..." },
		"not an object",
		null,
	]) {
		assert.equal(isUnsafeThinkingBlock(message, block), false);
	}
});

test("seedChildSession writes a fork with no signed thinking in it", async () => {
	const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { seedChildSession } = await import("../context.ts");

	const root = mkdtempSync(join(tmpdir(), "subagent-seed-"));
	const parentFile = join(root, "parent.jsonl");
	const ctx = { sessionManager: { getSessionFile: () => parentFile } };
	try {
		const seeded = await seedChildSession({
			ctx,
			directory: join(root, "child"),
			mode: "forked",
			cwd: root,
			messages: [
				user("do the thing"),
				anthropic([
					{ type: "thinking", thinking: "private plan", thinkingSignature: "SIGNATURE-XYZ" },
					{ type: "text", text: "on it" },
				]),
				// An assistant turn that was *only* signed thinking becomes empty and is
				// dropped rather than written as a contentless message.
				anthropic([{ type: "redacted_thinking", data: "REDACTED-BLOB" }]),
			],
		});
		const raw = readFileSync(seeded.sessionFile, "utf8");
		assert.ok(!raw.includes("SIGNATURE-XYZ"), "the signature must not reach the child session");
		assert.ok(!raw.includes("private plan"), "signed thinking text goes with its signature");
		assert.ok(!raw.includes("REDACTED-BLOB"));
		assert.ok(raw.includes("on it"), "the rest of the turn survives");
		assert.equal(seeded.messageCount, 2, "the emptied assistant turn is not counted");
		await seeded.cleanup();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("subagentsRoot keeps the agent tree in the project's self-ignoring .pi/", async () => {
	const { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { projectRoot, subagentsRoot, SUBAGENTS_DIR_ENV } = await import("../context.ts");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "subagent-root-")));
	const project = join(root, "repo");
	mkdirSync(join(project, ".jj"), { recursive: true });
	mkdirSync(join(project, "src", "deep"), { recursive: true });
	const saved = { agent: process.env.PI_CODING_AGENT_DIR, dir: process.env[SUBAGENTS_DIR_ENV] };
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env[SUBAGENTS_DIR_ENV];
	try {
		assert.equal(projectRoot(join(project, "src", "deep")), project);
		assert.equal(subagentsRoot(join(project, "src", "deep")), join(project, ".pi", "subagents"));
		assert.equal(readFileSync(join(project, ".pi", ".gitignore"), "utf-8"), "*\n");
		process.env[SUBAGENTS_DIR_ENV] = join(root, "pinned");
		assert.equal(subagentsRoot(join(project, "src")), join(root, "pinned"));
		delete process.env[SUBAGENTS_DIR_ENV];
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		assert.equal(subagentsRoot(project), join(root, "agent", "subagents"));
	} finally {
		if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved.agent;
		if (saved.dir === undefined) delete process.env[SUBAGENTS_DIR_ENV];
		else process.env[SUBAGENTS_DIR_ENV] = saved.dir;
		rmSync(root, { recursive: true, force: true });
	}
});

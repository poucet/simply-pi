/**
 * Reading a child's session file.
 *
 * A running child appends to its `session.jsonl` continuously, so the last line
 * may be half-written when we read it. We therefore parse line by line and drop
 * anything that does not parse, instead of using `SessionManager.open()` — which
 * would also open a writer against a file another process owns.
 *
 * The `message` payload of a `message` entry is exactly the `AgentMessage` the
 * interactive UI renders, so backfilled history is rendered by the very same
 * components as live traffic.
 */

import { readFileSync } from "node:fs";

/** Loose shape: we hand these straight to pi's message components. */
export type LoggedMessage = any;

export interface ChildSessionLog {
	messages: LoggedMessage[];
	/** Assistant `responseId`s seen, used to deduplicate the live/backfill seam. */
	responseIds: Set<string>;
	/** Tool call ids that already have a result in the log. */
	completedToolCallIds: Set<string>;
}

export function readChildSessionLog(sessionFile: string): ChildSessionLog {
	const log: ChildSessionLog = {
		messages: [],
		responseIds: new Set(),
		completedToolCallIds: new Set(),
	};

	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf-8");
	} catch {
		return log; // Not created yet: the child may still be booting.
	}

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue; // Partially written tail, or a record we do not understand.
		}
		if (entry?.type !== "message") continue;
		const message = entry.message;
		const role = message?.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

		log.messages.push(message);
		if (role === "assistant" && typeof message.responseId === "string") {
			log.responseIds.add(message.responseId);
		}
		if (role === "toolResult" && typeof message.toolCallId === "string") {
			log.completedToolCallIds.add(message.toolCallId);
		}
	}
	return log;
}

/** Flatten a user message's content to the text the UI shows. */
export function userMessageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n");
}

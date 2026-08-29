/**
 * Extension loaded *inside* every child agent (`pi --mode rpc -e <this file>`).
 *
 * It gives the child two ways to communicate:
 *
 *   report_to_parent  - push a material interim finding to the parent's mailbox.
 *                       The parent detects the tool call in the child's event
 *                       stream; the tool itself just acknowledges.
 *   shared_notes      - read/append the mission scratchpad that every sibling
 *                       agent shares. This is how siblings exchange interface
 *                       decisions without routing every word through the parent.
 *   ask_parent        - ask a clarifying question and block until answered,
 *                       without ending the turn. See ask.ts for why that needs
 *                       an onUpdate announcement rather than a return value.
 *
 * Configured entirely through env vars so the file stays generic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { answerPath, parseAnswer } from "./ask.ts";
import { ANSWERS_ENV, NOTES_ENV, SUBAGENT_LABEL_ENV } from "./identity.ts";
import { appendNote, readNotes } from "./notes.ts";

const MAX_REPORT_CHARS = 4_000;
const MAX_QUESTION_CHARS = 4_000;
/** How often the child looks for its answer. Cheap: one stat of one small file. */
const ANSWER_POLL_MS = 250;
/**
 * How often the child repeats its question on the event stream.
 *
 * Only matters when the parent has forgotten the question — which it does on
 * every reload, revive or hibernate of this child. A multiple of the poll
 * interval so the modulo in `waitForAnswer` is exact.
 */
const REANNOUNCE_EVERY_MS = 30_000;

export default function (pi: ExtensionAPI) {
	// A *label*, not an identity: it names log lines and the author field of a
	// shared-notes entry. Nothing is keyed by it — the parent keys everything by
	// this child's session uuid (see identity.ts), which is unique across the
	// whole tree where a name is unique only inside one parent.
	const agentName = process.env[SUBAGENT_LABEL_ENV] ?? "subagent";
	const notesPath = process.env[NOTES_ENV];
	const answersDir = process.env[ANSWERS_ENV];

	pi.registerTool({
		name: "report_to_parent",
		label: "Report",
		description:
			"Send a material interim finding to the parent agent (blockers, decisions, discovered " +
			"contracts). Use sparingly: the final response is delivered automatically when you finish.",
		promptSnippet: "Send an interim finding to the parent agent",
		promptGuidelines: [
			"Use report_to_parent only for findings the parent needs before you finish, such as a blocker or an interface decision others depend on.",
		],
		parameters: Type.Object({
			summary: Type.String({ description: "The finding, in a few sentences of Markdown" }),
		}),
		async execute(_id, params) {
			const summary = String(params.summary ?? "").slice(0, MAX_REPORT_CHARS);
			if (!summary.trim()) throw new Error("report_to_parent requires a non-empty summary");
			// The parent reads this off the event stream; nothing to do but confirm.
			return {
				content: [{ type: "text", text: "Reported to parent." }],
				details: { agent: agentName, summary },
			};
		},
	});

	if (answersDir) registerAskParent(pi, answersDir);

	if (!notesPath) return;

	pi.registerTool({
		name: "shared_notes",
		label: "Shared Notes",
		description:
			`Read or append to the shared mission notes at ${notesPath}. All sibling agents and the ` +
			"parent read this file. Append decisions, interfaces, and constraints that others must honor.",
		promptSnippet: "Read or append the shared mission notes",
		promptGuidelines: [
			"Read shared_notes before starting work, and append to shared_notes any interface or decision a sibling agent would need.",
		],
		parameters: Type.Object({
			action: StringEnum(["read", "append"] as const),
			text: Type.Optional(Type.String({ description: "Markdown to append (required for append)" })),
		}),
		async execute(_id, params) {
			if (params.action === "read") {
				const content = readNotes(notesPath);
				return {
					content: [{ type: "text", text: content.trim() || "(shared notes are empty)" }],
					details: { path: notesPath },
				};
			}

			// O_APPEND keeps concurrent sibling writes from interleaving mid-line.
			appendNote(notesPath, agentName, String(params.text ?? ""));
			return {
				content: [{ type: "text", text: "Appended to shared notes." }],
				details: { path: notesPath },
			};
		},
	});
}

/**
 * `ask_parent`: block the child mid-turn until the parent answers.
 *
 * The ordering is the whole design and it is not obvious:
 *
 *   1. `onUpdate` **first**. pi forwards that as `tool_execution_update` with
 *      `partialResult` intact, so the parent learns of the question while this
 *      tool call is still open. Returning the question instead would deadlock —
 *      the parent only sees a completed call at `tool_execution_end`, by which
 *      point the child's turn has ended and the context the question is about
 *      is gone.
 *   2. Then poll for the answer file, honouring the abort signal so an
 *      interrupt or a shutdown is not something the child can sit through.
 *   3. Return the answer as the tool result, so the child continues in the
 *      *same* turn with everything it was holding still in context.
 *
 * There is deliberately no timeout: a guessed answer is worse than a slow one.
 * The parent side makes the wait visible instead (`waiting` status).
 */
function registerAskParent(pi: ExtensionAPI, answersDir: string): void {
	pi.registerTool({
		name: "ask_parent",
		label: "Ask Parent",
		description:
			"Ask the parent agent a clarifying question and wait for its answer. Use this when a " +
			"genuine decision is missing and guessing would waste the work: an ambiguous requirement, " +
			"a choice between two designs the parent cares about, a missing credential or path. You " +
			"stay mid-task while you wait and continue with the answer in hand. Do not use it for " +
			"things you can determine yourself by reading the code.",
		promptSnippet: "Ask the parent agent a clarifying question and wait for the answer",
		promptGuidelines: [
			"Use ask_parent when a decision is genuinely the parent's to make and guessing would waste work; keep working yourself when you can find the answer in the code.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question, specific and answerable" }),
			context: Type.Optional(
				Type.String({ description: "What you have already tried or ruled out" }),
			),
		}),
		async execute(_id, params, signal, onUpdate) {
			const question = String(params.question ?? "").trim().slice(0, MAX_QUESTION_CHARS);
			if (!question) throw new Error("ask_parent requires a question");
			const context = String(params.context ?? "").trim().slice(0, MAX_QUESTION_CHARS);
			const questionId = `q-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

			// Step 1: announce. This is what reaches the parent mid-tool.
			onUpdate?.({
				content: [{ type: "text", text: `Waiting for the parent to answer: ${question}` }],
				details: { questionId, question, ...(context ? { context } : {}) },
			});

			// Step 2: wait. The file is written atomically by the parent, so a read
			// either sees nothing or sees the whole thing.
			//
			// The announcement is repeated while we wait. There is no timeout here by
			// decision, which makes the *parent* forgetting the question the only way
			// this can become a permanent block — and the parent legitimately forgets
			// it whenever it reloads, hibernates this child, or restarts it. A
			// re-announcement is idempotent on that side (the manager ignores an
			// update whose question id it already holds), so repeating costs nothing
			// and converts "blocked forever" into "blocked until the parent is back".
			const path = answerPath(answersDir, questionId);
			const reannounce = () =>
				onUpdate?.({
					content: [{ type: "text", text: `Waiting for the parent to answer: ${question}` }],
					details: { questionId, question, ...(context ? { context } : {}) },
				});
			const answer = await waitForAnswer(path, signal, reannounce);
			if (!answer) {
				// Only reachable by abort: the child is being stopped, and saying so
				// is better than returning an empty answer it might act on.
				throw new Error("ask_parent was interrupted before the parent answered");
			}

			// Step 3: hand the answer back as this call's result.
			return {
				content: [{ type: "text", text: answer.answer }],
				details: { questionId, answeredBy: answer.answeredBy ?? "parent" },
			};
		},
	});
}

/**
 * Poll for the answer file until it appears or the child is aborted.
 *
 * `reannounce` is called every `REANNOUNCE_EVERY_MS` so a parent that lost the
 * question (reload, revive, crash) is told about it again. Note what this loop
 * still does *not* have: a timeout. The block is unbounded on purpose, and it
 * is safe precisely because it is on this side of the process boundary — see
 * `SubagentManager.answer`, which only ever writes a file and never waits.
 */
async function waitForAnswer(
	path: string,
	signal?: AbortSignal,
	reannounce?: () => void,
): Promise<ReturnType<typeof parseAnswer>> {
	let waited = 0;
	for (;;) {
		if (signal?.aborted) return undefined;
		try {
			const answer = parseAnswer(readFileSync(path, "utf-8"));
			// A file that does not parse yet is a partial write, not a bad answer:
			// fall through and look again rather than failing the tool call.
			if (answer) return answer;
		} catch {
			// Not written yet.
		}
		const interrupted = await sleep(ANSWER_POLL_MS, signal);
		if (interrupted) return undefined;
		waited += ANSWER_POLL_MS;
		if (waited % REANNOUNCE_EVERY_MS === 0) {
			try {
				reannounce?.();
			} catch {
				// A closed channel is not a reason to stop waiting for the answer.
			}
		}
	}
}

/** Resolves true when the wait was cut short by an abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(true);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			resolve(true);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

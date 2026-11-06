/**
 * Keep agent shell commands from waiting on a human.
 *
 * pi's bash tool is non-interactive, but a command that opens an editor or a
 * pager (`jj squash`, `jj describe`, `git commit` or `git rebase -i` without a
 * message) still starts one and waits forever. That used to be guarded only by
 * a written rule agents had to remember. This extension forces it in code: every
 * `bash` tool call gets editors that exit at once, pagers that don't page, no
 * git credential prompts, and a default timeout so anything else that hangs
 * still ends.
 *
 * It rewrites the call's input in `tool_call`, so it applies to the root
 * session and to every subagent (children load this repo's extensions too). It
 * leaves pi's own process environment alone, so the TUI's external editor
 * (Ctrl+G) keeps using your real `$VISUAL` / `$EDITOR`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Forced on every agent shell command. jj and git read the tool-specific ones first. */
export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	EDITOR: "true",
	VISUAL: "true",
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	JJ_EDITOR: "true",
	PAGER: "cat",
	GIT_PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
};

/** Seconds a bash call may run when it doesn't give its own `timeout`. */
export const DEFAULT_TIMEOUT_SECONDS = 15 * 60;

const PREFIX = `export ${Object.entries(NON_INTERACTIVE_ENV)
	.map(([key, value]) => `${key}=${value}`)
	.join(" ")}\n`;

/** Rewrite a bash tool input in place. Idempotent. */
export function guardBashInput(input: { command?: unknown; timeout?: unknown }): void {
	if (typeof input.command === "string" && !input.command.startsWith(PREFIX)) {
		input.command = PREFIX + input.command;
	}
	if (input.timeout === undefined || input.timeout === null) {
		input.timeout = DEFAULT_TIMEOUT_SECONDS;
	}
}

export default function shellGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		guardBashInput(event.input as { command?: unknown; timeout?: unknown });
	});
}

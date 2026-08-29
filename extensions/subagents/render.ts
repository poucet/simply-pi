/**
 * How the `subagent` tool draws itself in the transcript.
 *
 * Without `renderCall`/`renderResult` pi falls back to a bold tool name in the
 * error-styled shell (`tool-execution.js:createCallFallback`), so every spawn,
 * message, followup and answer looks identical and says nothing. That is a real
 * auditability problem here specifically: a spawn hands a *prompt* — the task —
 * to a process with the human's credentials and their working tree, and the
 * human never sees the text of what was delegated.
 *
 * So the rule for this module is: the delegated text is the payload. The
 * collapsed row shows the action, the target and the first few lines of the
 * task/message; ctrl+o (`expanded`) shows it whole, never abridged.
 *
 * Everything below the two `render*` entry points is a pure `(args, theme) =>
 * string` function over a structural theme, following pi's own built-in tools
 * (`dist/core/tools/grep.js:formatGrepCall` and friends): the component layer is
 * three lines, and the interesting part is testable without a terminal.
 */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * The slice of pi's `Theme` these formatters use.
 *
 * Structural on purpose, exactly like `StripTheme` in switcher.ts: a test passes
 * a plain object and asserts on the text, and a real `Theme` still satisfies it.
 * Never hardcode escape sequences — every colour goes through here.
 */
export interface RenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

/** Lines of task/message text shown before the row is expanded. */
export const COLLAPSED_TEXT_LINES = 3;
/** Characters of task/message text shown before the row is expanded. */
export const COLLAPSED_TEXT_CHARS = 240;
/** Lines of tool output shown in a collapsed result. */
export const COLLAPSED_RESULT_LINES = 6;

export interface SubagentArgs {
	action?: string;
	mcp_servers?: string[];
	name?: string;
	task?: string;
	message?: string;
	persona?: string;
	cwd?: string;
	context?: string;
	model?: string;
	tools?: string[];
	notes_action?: string;
}

export interface RenderResultOptions {
	expanded?: boolean;
	isPartial?: boolean;
	/**
	 * The "press X to expand" affordance.
	 *
	 * Injected rather than hardcoded: `app.tools.expand` defaults to ctrl+o but is
	 * rebindable, and pi's built-ins render it through `keyHint`. Tests pass a
	 * fixed string; the component wrappers pass the real, theme-styled hint.
	 */
	expandHint?: string;
}

/** Fallback used when no hint is injected (tests, and any non-TUI caller). */
export const DEFAULT_EXPAND_HINT = "ctrl+o to expand";

/** The live, keybinding-aware affordance. Not pure: reads the global theme. */
function liveExpandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return DEFAULT_EXPAND_HINT;
	}
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** `/long/absolute/path` → `~/short` where we can, for a one-line header. */
export function shortenCwd(cwd: string, home = process.env.HOME ?? ""): string {
	if (!cwd) return cwd;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 * Clip text for the collapsed row.
 *
 * Both a line budget and a character budget: a task written as one enormous
 * paragraph must not eat the transcript any more than a task written as forty
 * short lines.
 */
export function clipText(
	text: string,
	lines = COLLAPSED_TEXT_LINES,
	chars = COLLAPSED_TEXT_CHARS,
): { text: string; clipped: boolean } {
	const all = text.split("\n");
	let kept = all.slice(0, lines).join("\n");
	let clipped = all.length > lines;
	if (kept.length > chars) {
		kept = kept.slice(0, chars).trimEnd();
		clipped = true;
	}
	return { text: kept, clipped };
}

/** The quoted body of a task/message, indented so it reads as a block. */
function quoteBlock(
	text: string,
	theme: RenderTheme,
	expanded: boolean,
	hint = DEFAULT_EXPAND_HINT,
): string {
	if (!text) return "";
	const { text: shown, clipped } = expanded ? { text, clipped: false } : clipText(text);
	let out = shown
		.split("\n")
		.map((line) => `\n  ${theme.fg("toolOutput", line)}`)
		.join("");
	if (clipped) {
		const hiddenLines = text.split("\n").length - shown.split("\n").length;
		const count =
			hiddenLines > 0 ? `${hiddenLines} more line${hiddenLines === 1 ? "" : "s"}, ` : "";
		out += `\n  ${theme.fg("muted", `… ${count}`)}${hint}`;
	}
	return out;
}

/** `spawn`, `read`, … in the position pi's built-ins put the tool name. */
function head(action: string, theme: RenderTheme): string {
	return `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", action)}`;
}

function targets(args: SubagentArgs): string[] {
	const single = str(args.name);
	return single ? [single] : [];
}

/**
 * The collapsed/expanded tool-call header.
 *
 * Shape per action:
 *   spawn     subagent spawn "name" · persona · cwd · context, then the task
 *   followup  subagent followup → "name", then the message
 *   read      subagent read a
 *   list      subagent list
 */
export function formatSubagentCall(
	args: SubagentArgs,
	theme: RenderTheme,
	options: { expanded?: boolean; expandHint?: string } = {},
): string {
	const action = str(args.action) || "?";
	const expanded = options.expanded === true;
	const hint = options.expandHint ?? DEFAULT_EXPAND_HINT;
	const quote = (text: string) => quoteBlock(text, theme, expanded, hint);
	let text = head(action, theme);

	switch (action) {
		case "spawn": {
			const name = str(args.name);
			if (name) text += ` ${theme.fg("text", theme.bold(`"${name}"`))}`;
			const meta: string[] = [];
			if (str(args.persona)) meta.push(`persona ${str(args.persona)}`);
			if (str(args.model)) meta.push(str(args.model));
			if (str(args.context)) meta.push(`${str(args.context)} context`);
			if (args.tools?.length) meta.push(`tools: ${args.tools.join(", ")}`);
			// Worth a row of its own: it is the one spawn argument that hands the child
			// credentials to systems outside this machine.
			if (args.mcp_servers?.length) meta.push(`mcp: ${args.mcp_servers.join(", ")}`);
			if (str(args.cwd)) meta.push(`in ${shortenCwd(str(args.cwd))}`);
			if (meta.length > 0) text += theme.fg("dim", ` (${meta.join(", ")})`);
			// The task is the whole point of the row: it is the prompt being handed
			// to another process, and the human asked to be able to audit it.
			const task = str(args.task);
			text += task
				? `\n${theme.fg("muted", "task:")}${quote(task)}`
				: `\n  ${theme.fg("error", "(no task)")}`;
			return text;
		}

		case "followup":
		case "message":
		case "answer": {
			const name = str(args.name);
			text += name
				? ` ${theme.fg("dim", "→")} ${theme.fg("text", theme.bold(`"${name}"`))}`
				: ` ${theme.fg("error", "(no target)")}`;
			const message = str(args.message);
			if (message) text += quote(message);
			return text;
		}

		case "read":
		case "close":
		case "interrupt":
		case "retry": {
			const names = targets(args);
			text += names.length > 0 ? ` ${theme.fg("text", names.join(", "))}` : "";
			if (action === "retry" && str(args.message)) text += quote(str(args.message));
			return text;
		}

		case "mcp": {
			const names = targets(args);
			text += names.length > 0 ? ` ${theme.fg("text", names.join(", "))}` : "";
			const scope = args.mcp_servers;
			text += theme.fg(
				"dim",
				` (${scope === undefined ? "no servers given" : scope.length ? scope.join(", ") : "none"})`,
			);
			return text;
		}

		case "notes": {
			const notesAction = str(args.notes_action) || "read";
			text += ` ${theme.fg("text", notesAction)}`;
			if (notesAction === "append" && str(args.message)) text += quote(str(args.message));
			return text;
		}

		case "list":
			return text;

		default: {
			const names = targets(args);
			if (names.length > 0) text += ` ${theme.fg("text", names.join(", "))}`;
			return text;
		}
	}
}

/** Result payloads the tool attaches via `details`; all fields optional by design. */
export interface SubagentDetails {
	agent?: string;
	cwd?: string;
	contextMode?: string;
	reclaimed?: string;
	delivered?: boolean;
	revived?: boolean;
	status?: string;
	silentForMs?: number;
	agents?: Array<{ name?: string; status?: string }>;
	path?: string;
}

export interface SubagentResult {
	content?: Array<{ type?: string; text?: string }>;
	details?: SubagentDetails;
	isError?: boolean;
}

export function resultText(result: SubagentResult | undefined): string {
	if (!result?.content) return "";
	return result.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

/** The body of a result: the tool's own prose, clipped unless expanded. */
function body(
	text: string,
	theme: RenderTheme,
	expanded: boolean,
	hint = DEFAULT_EXPAND_HINT,
): string {
	if (!text) return "";
	const lines = text.split("\n");
	const shown = expanded ? lines : lines.slice(0, COLLAPSED_RESULT_LINES);
	let out = shown.map((line) => `\n${theme.fg("toolOutput", line)}`).join("");
	const remaining = lines.length - shown.length;
	if (remaining > 0) {
		out += `\n${theme.fg("muted", `… ${remaining} more line${remaining === 1 ? "" : "s"}, `)}${hint}`;
	}
	return out;
}

/**
 * The tool result row.
 *
 * `spawn` and `read` get a digest built from `details` rather than the raw
 * prose, because those are the two the orchestrator acts on. Everything else
 * falls through to a one-line confirmation plus the tool's own text.
 */
export function formatSubagentResult(
	result: SubagentResult,
	args: SubagentArgs,
	theme: RenderTheme,
	options: RenderResultOptions = {},
): string {
	const action = str(args.action) || "?";
	const expanded = options.expanded === true;
	const hint = options.expandHint ?? DEFAULT_EXPAND_HINT;
	const rest = (text: string) => body(text, theme, expanded, hint);
	const text = resultText(result);

	if (options.isPartial) {
		// The spawn path streams progress through onUpdate; show it verbatim so a
		// slow summarization reads as work rather than as a hang.
		return theme.fg("warning", text || `${action}…`);
	}

	if (result.isError) {
		// Errors keep pi's error styling and are never clipped to one line: the
		// reason a spawn failed (bad persona, name collision, no slots) is the
		// entire content of the row.
		return theme.fg("error", text || "failed");
	}

	const details = result.details ?? {};

	switch (action) {
		case "spawn": {
			const name = details.agent ?? str(args.name) ?? "";
			let out = `${theme.fg("success", "✓ spawned")} ${theme.fg("text", theme.bold(`"${name}"`))}`;
			const meta: string[] = [];
			if (details.contextMode) meta.push(`${details.contextMode} context`);
			if (details.cwd) meta.push(shortenCwd(details.cwd));
			if (meta.length > 0) out += theme.fg("dim", ` — ${meta.join(", ")}`);
			out += `\n${theme.fg("muted", "running in the background; its result is delivered automatically")}`;
			if (details.reclaimed) {
				out += `\n${theme.fg("warning", `closed "${details.reclaimed}" to free a slot`)}`;
			}
			return out;
		}

		case "read": {
			const name = details.agent ?? str(args.name) ?? "";
			let out = `${theme.fg("muted", name)} ${theme.fg("dim", `[${details.status ?? "?"}]`)}`;
			out += rest(text);
			return out;
		}

		case "list": {
			const agents = details.agents ?? [];
			let out =
				agents.length === 0
					? theme.fg("muted", "no subagents")
					: theme.fg("success", `${agents.length} subagent${agents.length === 1 ? "" : "s"}`);
			out += rest(text);
			return out;
		}

		case "answer": {
			const name = details.agent ?? str(args.name) ?? "";
			return details.delivered === false
				? theme.fg("warning", `"${name}" had no question outstanding — sent as a message`)
				: `${theme.fg("success", "✓ answered")} ${theme.fg("text", name)}`;
		}

		case "notes": {
			const out = theme.fg(
				"success",
				str(args.notes_action) === "append" ? "✓ appended" : "shared notes",
			);
			return out + rest(text);
		}

		default: {
			// message/followup/close/interrupt/retry: the tool's own one-liner is
			// already the right thing to show, with any remainder below it.
			if (!text) return theme.fg("success", "done");
			const [first, ...remainder] = text.split("\n");
			return theme.fg("success", first) + rest(remainder.join("\n"));
		}
	}
}

// --------------------------------------------------------------- components ---
// Thin by design: everything above is a pure function so the tests never need a
// terminal. `context.lastComponent` is reused in place, as pi's built-ins do.

export function renderSubagentCall(args: any, theme: any, context: any): Text {
	const component: Text = context?.lastComponent ?? new Text("", 0, 0);
	component.setText(
		formatSubagentCall(args ?? {}, theme, {
			expanded: context?.expanded === true,
			expandHint: liveExpandHint(),
		}),
	);
	return component;
}

export function renderSubagentResult(result: any, options: any, theme: any, context: any): Text {
	const component: Text = context?.lastComponent ?? new Text("", 0, 0);
	// `context.args`, not a copy stashed in `state`: pi's own guidance, and it is
	// the only source that is correct after a session reload rebuilds the row.
	component.setText(
		formatSubagentResult(result ?? {}, context?.args ?? {}, theme, {
			expanded: options?.expanded === true,
			isPartial: options?.isPartial === true,
			expandHint: liveExpandHint(),
		}),
	);
	return component;
}

/**
 * subagents — delegate work to child agents that run in their own conversations,
 * their own processes, and (crucially) their own working directories.
 *
 * Design notes:
 *   - Spawning never blocks the parent. `spawn` returns as soon as the child has
 *     accepted its task; results come back through a mailbox. If the parent is
 *     mid-turn the mail rides into its next request; if the parent is idle a
 *     final result wakes it, so the orchestrator reacts without the human having
 *     to type. Interim reports never wake anything.
 *   - Children inherit parent context (forked/compacted) so delegation does not
 *     mean starting from zero.
 *   - Nothing here knows about git, jj, or worktrees. A child just takes a `cwd`.
 *     How that directory comes into existence is a project-level concern; see
 *     the delegate-worktree skill and your project's AGENTS.md.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { Type } from "typebox";
import {
	disposeChatPanes,
	forgetChatPane,
	formatCost,
	openSubagentChat,
	openTextOverlay,
	switcherLines,
} from "./chat-view.ts";
import { subagentsEditorFactory } from "./editor.ts";
import {
	HIBERNATE_ENTRY_TYPE,
	buildPayload,
	collectRecords,
	hasHibernateEntry,
	shutdownPolicy,
} from "./hibernate.ts";
import { isSubagentBoot, sessionIdentity } from "./identity.ts";
import type { MailKind } from "./mailbox.ts";
import { SubagentManager, onDeadlineExceeded } from "./manager.ts";
import {
	DEFAULT_AUTO_RESTORE_MAX_AGE_MINUTES,
	Registry,
	autoRestorable,
	describeRestorable,
	restorableNodes,
	type RegistryNode,
} from "./registry.ts";
import { parseMcpScope } from "../shared/mcp-scope.ts";
import { DEFAULT_CHILD_DENY, parseDenyList } from "./deny.ts";
import { DEFAULT_IDLE_HIBERNATE_MINUTES } from "./reap.ts";
import { DEFAULT_AUTO_RESUME_MAX_AGE_MINUTES, DEFAULT_MAX_RESUME_ATTEMPTS } from "./resume.ts";
import { DEFAULT_STALL_SECONDS, describeSilence } from "./stall.ts";
import { describeTransitionTable } from "./transitions.ts";
import { appendNote, readNotes } from "./notes.ts";
import { hasRenderer, publish, subscribe } from "../shared/border-badges.ts";
import {
	type OnFinishMode,
	formatStatus,
	returnMail,
	routeMail,
	selfDriving,
	statusBadges,
	takeMail,
} from "./notify.ts";
import { describePersonas, discoverPersonas } from "./personas.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { MAIN_ENTRY_ID, SwitcherStrip } from "./switcher.ts";
import type { ChatHost } from "./types.ts";

type OrchestrateMode = "off" | "nudge" | "strict";

interface SubagentsSettings {
	orchestrate: OrchestrateMode;
	/**
	 * Extensions a child must not inherit (discovery name or absolute path).
	 *
	 * Children inherit everything else you have configured. One denylist rather
	 * than a setting per extension, so "what does a child load?" has a single
	 * answer. See deny.ts for the matching rules.
	 */
	childDeny: string[];
	/**
	 * MCP servers a child boots when its spawn does not say otherwise.
	 *
	 * An allowlist, empty by default: children get the `mcp` extension now, but no
	 * servers unless asked, so nobody's spawns silently start booting ~90 tools.
	 * `["*"]` restores inherit-everything. Overridable per spawn and adjustable
	 * afterwards; see `shared/mcp-scope.ts` and the tool's `mcp_servers` param.
	 */
	childMcpServers: string[];
	/** Load personas from `.pi/agents` in the project as well as `~/.pi/agent/agents`. */
	projectPersonas: boolean;
	/** Whether a final result wakes an idle parent, or only updates the footer. */
	onFinish: OnFinishMode;
	/** Seconds of silence from a busy child before it is reported as stalled; 0 disables. */
	stallSeconds: number;
	/** Minutes a completed child may idle before it hibernates itself; 0 disables. */
	idleHibernateMinutes: number;
	/**
	 * Whether interrupted work restarts itself at all.
	 *
	 * On by default: the alternative is work silently stranded on disk, which is
	 * what used to happen. Off is for anyone who would rather approve each revive
	 * by hand with `/agents restore`.
	 */
	autoResume: boolean;
	/**
	 * How old interrupted work may be and still restart itself at a cold start.
	 *
	 * A reload resumes regardless of age — the process was alive moments ago. `0`
	 * removes the bound, so even day-old work restarts. See `resume.ts`.
	 */
	autoResumeMaxAgeMinutes: number;
	/** How many times a child may auto-resume before it is declared broken; 0 disables the cap. */
	maxResumeAttempts: number;
	/**
	 * How old a previous run's children may be and still be adopted by themselves.
	 *
	 * Adopting costs nothing — no process is started — so this is about clutter,
	 * not tokens: without a bound, a registry full of leftovers would resurrect the
	 * same pile at every launch. `0` removes the bound. See `registry.ts`.
	 */
	autoRestoreMaxAgeMinutes: number;
}

const DEFAULT_SETTINGS: SubagentsSettings = {
	orchestrate: "nudge",
	childDeny: [...DEFAULT_CHILD_DENY],
	childMcpServers: [],
	projectPersonas: false,
	onFinish: "wake",
	stallSeconds: DEFAULT_STALL_SECONDS,
	idleHibernateMinutes: DEFAULT_IDLE_HIBERNATE_MINUTES,
	autoResume: true,
	autoResumeMaxAgeMinutes: DEFAULT_AUTO_RESUME_MAX_AGE_MINUTES,
	maxResumeAttempts: DEFAULT_MAX_RESUME_ATTEMPTS,
	autoRestoreMaxAgeMinutes: DEFAULT_AUTO_RESTORE_MAX_AGE_MINUTES,
};

/**
 * What the `list` action says about agents this session did *not* adopt.
 *
 * It used to say "Ask the human to run /agents restore", which is now wrong on
 * both counts: the previous run's children in this directory come back by
 * themselves, and the ones that do not are held back on purpose. The
 * orchestrator is told what they are so it does not treat them as work in
 * flight and, worse, delegate the same task twice.
 */
const RESTORABLE_NOTE =
	"These belong to another directory or an older run, so they were deliberately " +
	"not adopted and nothing of theirs is running. They are not yours to report on; " +
	"the human can run /agents restore if they want them in this session.";

function settingsPath(): string {
	return join(getAgentDir(), "subagents.json");
}

function loadSettings(): SubagentsSettings {
	try {
		const raw = JSON.parse(readFileSync(settingsPath(), "utf-8"));
		return {
			orchestrate: ["off", "nudge", "strict"].includes(raw?.orchestrate)
				? raw.orchestrate
				: DEFAULT_SETTINGS.orchestrate,
			projectPersonas: raw?.projectPersonas === true,
			onFinish: ["wake", "notify"].includes(raw?.onFinish) ? raw.onFinish : DEFAULT_SETTINGS.onFinish,
			stallSeconds:
				typeof raw?.stallSeconds === "number" && Number.isFinite(raw.stallSeconds) && raw.stallSeconds >= 0
					? raw.stallSeconds
					: DEFAULT_SETTINGS.stallSeconds,
			idleHibernateMinutes:
				typeof raw?.idleHibernateMinutes === "number" &&
				Number.isFinite(raw.idleHibernateMinutes) &&
				raw.idleHibernateMinutes >= 0
					? raw.idleHibernateMinutes
					: DEFAULT_SETTINGS.idleHibernateMinutes,
			// Explicit `false` disables it; anything else (including absent) leaves it
			// on, because stranding work is the failure mode being fixed.
			autoResume: raw?.autoResume !== false,
			autoResumeMaxAgeMinutes:
				typeof raw?.autoResumeMaxAgeMinutes === "number" &&
				Number.isFinite(raw.autoResumeMaxAgeMinutes) &&
				raw.autoResumeMaxAgeMinutes >= 0
					? raw.autoResumeMaxAgeMinutes
					: DEFAULT_SETTINGS.autoResumeMaxAgeMinutes,
			maxResumeAttempts:
				typeof raw?.maxResumeAttempts === "number" &&
				Number.isFinite(raw.maxResumeAttempts) &&
				raw.maxResumeAttempts >= 0
					? raw.maxResumeAttempts
					: DEFAULT_SETTINGS.maxResumeAttempts,
			autoRestoreMaxAgeMinutes:
				typeof raw?.autoRestoreMaxAgeMinutes === "number" &&
				Number.isFinite(raw.autoRestoreMaxAgeMinutes) &&
				raw.autoRestoreMaxAgeMinutes >= 0
					? raw.autoRestoreMaxAgeMinutes
					: DEFAULT_SETTINGS.autoRestoreMaxAgeMinutes,
			childDeny: parseDenyList(raw?.childDeny),
			// Deliberately *not* named `childMcp`. That key existed, meant something
			// else (whether a child got the MCP extension at all), and is still
			// sitting in configs on disk. Reusing the name would give a stale value
			// new semantics silently, which is the one failure a config key must
			// never have.
			childMcpServers: parseMcpScope(raw?.childMcpServers) ?? DEFAULT_SETTINGS.childMcpServers,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Settings keys that no longer do anything.
 *
 * `childExtensions` was an allowlist from when children ran with
 * `--no-extensions` and inherited nothing; `childMcp` decided whether a child
 * loaded the MCP extension. Both were superseded and both were then *ignored
 * silently*, which is how a user ends up with a `childExtensions` entry pointing
 * at a file that has since moved away and no hint that it stopped mattering
 * years of edits ago. Ignoring them is still the right behaviour — rejecting
 * would break a config that is otherwise fine — but saying so once is cheap.
 */
const OBSOLETE_SETTINGS: Record<string, string> = {
	childExtensions:
		"children inherit your extensions now; use childDeny to withhold specific ones",
	childMcp: "use childMcpServers to choose which MCP servers a child boots",
};

/** Obsolete keys actually present in the user's config, for a one-time warning. */
function obsoleteSettingKeys(): string[] {
	try {
		const raw = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;
		return Object.keys(OBSOLETE_SETTINGS).filter((key) => raw?.[key] !== undefined);
	} catch {
		return [];
	}
}

function saveSettings(settings: SubagentsSettings): void {
	mkdirSync(dirname(settingsPath()), { recursive: true });
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

/**
 * Orchestrator guidance lives in `orchestrator.md` next to this file so it can be
 * edited without touching code. A user copy at `~/.pi/agent/subagents-orchestrator.md`
 * overrides it. Re-read on every turn so edits apply without a reload.
 */
const BUNDLED_ORCHESTRATOR_PROMPT = fileURLToPath(new URL("./orchestrator.md", import.meta.url));

function orchestratorPrompt(): string {
	const userCopy = join(getAgentDir(), "subagents-orchestrator.md");
	for (const path of [userCopy, BUNDLED_ORCHESTRATOR_PROMPT]) {
		try {
			const text = readFileSync(path, "utf-8").trim();
			if (text) return text;
		} catch {
			// Try the next candidate.
		}
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	/**
	 * The one thing that can be known before a session exists.
	 *
	 * Children run with normal extension discovery — a subagent should be the same
	 * agent as you, elsewhere — so this file is loaded inside them too, and the
	 * guard has to run here, in the factory, where there is no session to ask.
	 * `PI_SUBAGENT=1` is therefore a *boot flag* and carries no identity: which
	 * agent this is, and whose child it is, live in the session header (see
	 * identity.ts) where they survive a resume and a revive.
	 *
	 * What the flag suppresses is deliberately narrower than it used to be. It
	 * skips the **UI** — widget, editor component, footer status, `/agents` — all
	 * of which would have a child painting into a terminal it does not own. It no
	 * longer suppresses the **tool**: subagents may spawn subagents, so removing
	 * the tool would be enforcing a policy that has been explicitly rejected.
	 */
	const registersUi = !isSubagentBoot();

	let settings = loadSettings();
	let uiContext: any;
	/** The only handle an extension gets for redrawing a widget it does not own. */
	let tui: any;
	/**
	 * The live editor, kept solely so it can be told when it stops being the
	 * editor.
	 *
	 * `EditorComponent` has no teardown hook — nothing tells an instance it has
	 * been replaced — and this one holds a subscription to the badge registry and a
	 * vote in `hasRenderer()`. Both have to be given back, or a reload leaves a dead
	 * editor asking a dead TUI to repaint while publishers still believe somebody is
	 * drawing their badges.
	 */
	let editor: { dispose(): void } | undefined;
	/**
	 * Whether anything was drawing the bar last time we looked, and how to stop
	 * watching.
	 *
	 * The same watch `extensions/mcp` keeps, and kept for the same reason rather
	 * than as a copy: `refreshUi` runs at the end of `session_start`, but pi does
	 * not construct the editor until it first paints, so the footer sentence is
	 * written before the bar exists and has to be taken back down once it does.
	 */
	let rendererPresent = false;
	let unwatchRenderer: (() => void) | undefined;

	/**
	 * The agent tree on disk, outside any session.
	 *
	 * Created once at load, not per session, because it is deliberately not scoped
	 * to a session: its whole purpose is to be readable by a pi that has never
	 * opened the session the children were spawned from (see registry.ts).
	 */
	const registry = new Registry();
	/**
	 * Nodes a cold start found and deliberately did **not** adopt.
	 *
	 * What is left after the automatic pass: another project's children, or work
	 * older than `autoRestoreMaxAgeMinutes`. `/agents restore` is how they come
	 * back, and it is deliberately an explicit request — see `surveyRegistry`.
	 */
	let restorable: RegistryNode[] = [];
	/**
	 * Set while a cold start is adopting the previous run's records.
	 *
	 * Restoring N agents publishes N pieces of `restored` mail, and mail that
	 * wakes an idle parent would mean **opening pi starts a model turn before the
	 * human has typed anything** — the surprise this whole path is trying to avoid.
	 * Nothing is running and nothing is blocked, so the mail waits in the mailbox
	 * and rides into the first real request (`before_agent_start`), which is the
	 * first moment the orchestrator can act on it anyway. The per-agent toasts are
	 * suppressed for the same reason: `adoptPreviousRun` says it once, with a
	 * count.
	 *
	 * Deliberately *not* applied to auto-resume: an agent that is editing files
	 * again is news the orchestrator has to have now, and it wakes as before.
	 */
	let adoptingQuietly = false;
	/** This session's uuid, when it is a root and therefore may claim the tree. */
	let rootSessionId: string | undefined;
	let rootClaimed = false;

	/**
	 * Record this session as the root of the tree — once, and only if it has one.
	 *
	 * Deferred to the first spawn rather than done at `session_start`, so merely
	 * launching pi (or running `--list-models`) does not rewrite the registry and
	 * hand the root to a session with no children in it.
	 */
	function claimRoot(): void {
		if (rootClaimed || !rootSessionId) return;
		rootClaimed = true;
		try {
			registry.setRoot(rootSessionId);
		} catch {
			/* the registry is never load-bearing */
		}
	}

	const manager = new SubagentManager(
		{
			onChange: () => refreshUi(),
			onMail: (agentName, kind) => {
				try {
					if (uiContext?.hasUI) {
						// A Record, not a ternary chain: a new MailKind that fell through to
						// "reported" would be described to the human as routine chatter.
						const labels: Record<MailKind, string> = {
							report: "reported",
							final: "finished",
							error: "failed",
							question: "is waiting for an answer",
							stall: "has gone silent",
							hibernated: "hibernated after being idle",
							restored: "is back from a previous run",
						};
						const severity: Record<MailKind, string> = {
							report: "info",
							final: "info",
							error: "error",
							question: "warning",
							stall: "warning",
							hibernated: "info",
							restored: "info",
						};
						// `onStall` and `onReap` already say these two in the human's own words,
						// with the recovery gesture attached; a second toast is just noise. A
						// quiet adoption is the same story with a different teller: one summary
						// toast beats six.
						if (kind !== "stall" && kind !== "hibernated" && !adoptingQuietly) {
							uiContext.ui.notify(
								`subagent ${agentName} ${labels[kind] ?? "reported"}`,
								severity[kind] ?? "info",
							);
						}
					}
				} catch {
					/* the toast is the least important of the three signals */
				}
				refreshUi();
				// Four outcomes, three of which are self-driving. The old code had two,
				// and its "ride" branch meant "never" for a parent with no human.
				switch (
					// "ride" during a quiet adoption: the mail is still published, so the
					// orchestrator learns about these agents the first time it runs — it just
					// does not get to start a turn about them while the human is still
					// looking at an empty prompt.
					adoptingQuietly
						? "ride"
						: routeMail({
								kind,
								idle: parentIsIdle(),
								onFinish: settings.onFinish,
								hasUI: parentHasUI(),
							})
				) {
					case "wake":
						scheduleWake();
						break;
					case "steer":
						// Something is stopped and the parent is mid-turn: land it between
						// tool calls rather than after a turn that may run for minutes.
						steerParent();
						break;
					case "at-settle":
						// The parent is mid-turn and this can wait for the end of it — but
						// only for the end of it, never for a human to type.
						wakeWhenIdle = true;
						break;
					case "ride":
						// `report` only. Deliberately passive: see routeMail.
						break;
				}
			},
			// A stall is a human problem (usually the wifi), not an agent result: it
			// is surfaced once, and never woken into the orchestrator's context — the
			// child has produced nothing to reason about.
			onStall: (agent, silentForMs) => {
				try {
					uiContext?.ui?.notify(
						`subagent ${agent.name} has been silent for ${describeSilence(silentForMs)} — ` +
							`check your connection, then subagent action:"retry" name:"${agent.name}"`,
						"warning",
					);
				} catch {
					/* the footer already says "1 stalled" */
				}
				refreshUi();
			},
			// Said out loud because both are things the human did not ask for: one
			// releases a process, the other ends a conversation.
			// A denylist typo fails open — the child inherits the very thing you meant
			// to exclude — so an entry that matches nothing is said out loud once.
			onDenyMiss: (entry, discovered) => {
				try {
					uiContext?.ui?.notify(
						`subagents: childDeny entry "${entry}" matches no extension ` +
							`(discovered: ${discovered.join(", ") || "none"})`,
						"warning",
					);
				} catch {
					/* nothing to warn on in a headless session */
				}
			},
			// A revived child no longer loading what it loaded before is exactly the
			// bug this reporting exists to prevent: the old code dropped moved
			// extensions in silence. Re-resolving fixes the drop; this is what keeps
			// it from being just as quiet about the fix.
			onExtensionDrift: (agent, recorded, resolved) => {
				const name = (path: string) => path.split("/").pop() ?? path;
				try {
					if (!resolved) {
						uiContext?.ui?.notify(
							`subagents: could not re-resolve extensions for "${agent.name}"; reviving on ` +
								`its recorded paths, some of which may be gone (${recorded.map(name).join(", ")})`,
							"warning",
						);
						return;
					}
					const was = new Set(recorded);
					const now = new Set(resolved);
					const gained = resolved.filter((path) => !was.has(path)).map(name);
					const lost = recorded.filter((path) => !now.has(path)).map(name);
					uiContext?.ui?.notify(
						`subagents: "${agent.name}" revived with re-resolved extensions` +
							`${gained.length ? ` (+${gained.join(", ")})` : ""}` +
							`${lost.length ? ` (-${lost.join(", ")})` : ""}`,
						"info",
					);
				} catch {
					/* nothing to warn on in a headless session */
				}
			},
			// The human's half of this. The orchestrator's half is `hibernated` mail,
			// published by the transition itself (transitions.ts) rather than from here:
			// a notification path that reaches the human and not the orchestrator is the
			// exact shape of the stall bug.
			onReap: (agent, kind) => {
				try {
					uiContext?.ui?.notify(
						kind === "idle"
							? `subagent ${agent.name} hibernated after being idle — message it to resume`
							: `subagent ${agent.name} was closed to free a slot for a new agent`,
						"info",
					);
				} catch {
					/* the switcher shows the new state either way */
				}
			},
		},
		{
			registry,
			childDeny: settings.childDeny,
			childMcpServers: settings.childMcpServers,
			stallSeconds: settings.stallSeconds,
			idleHibernateMinutes: settings.idleHibernateMinutes,
			autoResumeMaxAgeMinutes: settings.autoResumeMaxAgeMinutes,
			maxResumeAttempts: settings.maxResumeAttempts,
		},
	);

	/**
	 * Surface every bounded await that actually hit its deadline.
	 *
	 * The deadlines exist so a wedged child cannot wedge pi (see the liveness
	 * invariant at the top of manager.ts). But one firing always means something
	 * is wrong upstream — a child that stopped answering, a hung filesystem, a
	 * provider ignoring its abort signal — and a backstop that trips silently is
	 * how this class of bug went unnoticed long enough to freeze a session. So it
	 * is said out loud, once per distinct operation, in the same place the human
	 * already looks for subagent trouble.
	 */
	const reportedDeadlines = new Set<string>();
	onDeadlineExceeded(({ what, ms }) => {
		if (reportedDeadlines.has(what)) return;
		reportedDeadlines.add(what);
		try {
			uiContext?.ui?.notify(
				`subagents: ${what} exceeded its ${Math.round(ms / 1000)}s deadline and was abandoned — ` +
					"pi stayed responsive, but something is not answering",
				"warning",
			);
		} catch {
			/* headless, or the session is going away */
		}
	});

	/**
	 * The housekeeping sweep: liveness, and idle reaping.
	 *
	 * Both are about the *absence* of activity, which nothing in the event stream
	 * can detect — only a clock can. One timer does both because they read the
	 * same state and neither is urgent. Unref'd so it never keeps the process
	 * alive, and only running while there are children.
	 */
	let stallTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * The auto-resume started by `session_start`, while it is still running.
	 *
	 * Tracked rather than fired and forgotten: it starts child processes, and the
	 * liveness invariant at the top of manager.ts says every await must be
	 * observable and cancellable. A shutdown that raced it used to leave the
	 * children it was mid-way through launching with nobody holding their handles.
	 */
	let resumeInFlight: Promise<void> | undefined;
	let resumeAbort = new AbortController();

	function updateStallTimer(): void {
		const sweeps = settings.stallSeconds > 0 || settings.idleHibernateMinutes > 0;
		const wanted = sweeps && manager.list().length > 0;
		if (wanted && !stallTimer) {
			// Checked far more often than the stall threshold so the reported silence
			// is roughly true rather than rounded up to a whole stall period. The idle
			// sweep is happy at any frequency; its threshold is in minutes.
			const period =
				settings.stallSeconds > 0
					? Math.max(5_000, Math.min(30_000, (settings.stallSeconds * 1000) / 4))
					: 30_000;
			stallTimer = setInterval(() => {
				try {
					if (settings.stallSeconds > 0) manager.sweepStalls();
				} catch {
					/* a bad sweep must not kill the timer */
				}
				// Awaited by nobody: hibernating stops a process, which can take a
				// moment, and the timer must not serialize on it.
				void manager.sweepIdle().catch(() => {});
			}, period);
			stallTimer.unref?.();
		} else if (!wanted && stallTimer) {
			clearInterval(stallTimer);
			stallTimer = undefined;
		}
	}

	// ------------------------------------------------------------------- ui --

	/** Everything the chat UI is allowed to know about the manager. */
	const chatHost: ChatHost = {
		agents: () => manager.list(),
		unread: (agentId) => manager.mailbox.peek().filter((event) => event.agentId === agentId).length,
		statusIcon: (agent) => manager.statusIcon(agent.status),
		subscribe: (agentId, listener) => manager.onAgentEvent(agentId, listener),
		send: async (agentId, text) => {
			const agent = manager.require(agentId);
			// No signal here: this is a keypress inside the chat overlay, not a turn,
			// so there is nothing for Escape to cancel. `ChildRpc`'s own request
			// ceiling is what keeps a wedged child from freezing the overlay.
			await manager.send(agent.id, text, agent.busy ? "steer" : "followUp");
		},
	};

	/**
	 * The selectable chat strip. Cooperative focus: it never takes the keyboard,
	 * the wrapped editor forwards keys to it (see editor.ts and switcher.ts).
	 */
	const strip = new SwitcherStrip(chatHost, {
		requestRender: () => tui?.requestRender(),
		open: (entryId) => {
			if (entryId === MAIN_ENTRY_ID || !uiContext) return;
			void openChat(uiContext, entryId);
		},
	});

	/**
	 * One switcher below the editor: every agent, its state and an unread marker,
	 * then the strip itself. The persistent status is the second signal — a toast
	 * that has already faded is not a notification.
	 *
	 * That status has two possible homes and takes exactly one of them. The badges
	 * go to the shared registry, where they are drawn as `🤖 2` in the editor's
	 * top border; the sentence goes to pi's footer, but **only when nothing is
	 * drawing the bar**. See `publishBadges`.
	 */
	function refreshUi(): void {
		// Called from child event handlers, which can outlive their context by a few
		// milliseconds on shutdown; a stale context throws rather than lying.
		try {
			// The sweep must keep running in a headless session too: the mail and the
			// tool output depend on stall state, not just the widget.
			updateStallTimer();
			// A child never paints: the terminal belongs to the root agent, and a
			// widget or footer status written from a subagent process would appear in
			// a UI that is not its own. It publishes nothing either — a child is its own
			// process with its own registry, so anything it published would be read by
			// nobody.
			if (!registersUi) return;
			// Before the `hasUI` guard: badges are data rather than paint, and whether
			// *this* context can draw says nothing about whether the bar can. (Today the
			// bar is drawn by this same extension, which makes that distinction look
			// academic — it stops being academic the moment something else takes the
			// editor slot, which is exactly the case the registry exists for.)
			publishBadges();
			if (!uiContext?.hasUI) return;
			uiContext.ui.setStatus(
				"subagents",
				// `undefined` clears the entry, both when there are no agents and when the
				// border bar is already showing these facts. Deliberately asked rather
				// than assumed: this extension owns the editor *today*, and special-casing
				// itself here would be wrong the moment it does not.
				hasRenderer()
					? undefined
					: formatStatus(
							manager.list().map((agent) => agent.status),
							manager.mailbox.size,
						),
			);
			if (manager.list().length === 0) {
				uiContext.ui.setWidget("subagents", undefined, { placement: "belowEditor" });
				return;
			}
			uiContext.ui.setWidget(
				"subagents",
				// Rendered fresh each frame: the agents, their costs, the unread markers
				// and the selection all move, and theme changes must be picked up.
				(widgetTui: any, theme: any) => {
					tui ??= widgetTui;
					return {
						render: (width: number) => switcherLines(chatHost, theme, strip, width),
						invalidate: () => {},
					};
				},
				{ placement: "belowEditor" },
			);
		} catch {
			/* the session is going away; there is nothing to draw on */
		}
	}

	/**
	 * Put this extension's own chip on the shared bar.
	 *
	 * `undefined` withdraws the source entirely, which is how "no subagents" leaves
	 * no trace — the same contract `extensions/mcp` uses. Republishing identical
	 * badges notifies nobody, so calling this from every `refreshUi` (which fires on
	 * every child event) costs one comparison rather than a repaint.
	 */
	function publishBadges(): void {
		publish(
			"subagents",
			statusBadges(
				manager.list().map((agent) => agent.status),
				manager.mailbox.size,
			),
		);
	}

	async function openChat(ctx: any, agentNameOrId?: string): Promise<void> {
		if (manager.list().length === 0) {
			ctx.ui.notify("No subagents in this session", "info");
			return;
		}
		let target = agentNameOrId ? manager.get(agentNameOrId) : undefined;
		if (agentNameOrId && !target) {
			ctx.ui.notify(`unknown subagent "${agentNameOrId}"`, "error");
			return;
		}
		if (!target) {
			// Open where attention is due: an agent with pending mail, else the newest.
			const agents = manager.list();
			target = agents.find((agent) => chatHost.unread(agent.id) > 0) ?? agents.at(-1);
		}
		await openSubagentChat(ctx.ui, chatHost, target?.id);
	}

	// ----------------------------------------------------------- mail wiring --

	/**
	 * Whether this session has ever carried a hibernation record.
	 *
	 * Once it has, every shutdown must write a fresh one — including an empty one
	 * — or closing every child and reloading would bring them all back.
	 */
	let restoredFromSession = false;

	/** Armed when a result lands while the parent is busy; fired when it settles. */
	let wakeWhenIdle = false;
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;

	function parentIsIdle(): boolean {
		try {
			// A context captured before a reload throws instead of lying.
			return uiContext?.isIdle?.() === true && uiContext?.hasPendingMessages?.() !== true;
		} catch {
			return false;
		}
	}

	/**
	 * Whether a human is watching this parent.
	 *
	 * `false` for every intermediate parent in a nested tree — a `pi --mode rpc`
	 * child is an orchestrator with children of its own and no terminal. That is
	 * the case where "the mail rides into the next request" means *never*, so it
	 * has to be asked explicitly rather than assumed.
	 */
	function parentHasUI(): boolean {
		try {
			return uiContext?.hasUI === true;
		} catch {
			return false;
		}
	}

	/**
	 * Is this an ongoing agent session, as opposed to a one-shot command?
	 *
	 * **The gate on starting processes.** Auto-resume spawns children, and a child
	 * launched by a command that is about to exit is stranded immediately — that is
	 * how the test suite came to leave live `pi --mode rpc` processes behind and
	 * hang. So this must exclude one-shot invocations *provably*, not hopefully.
	 *
	 * Two signals, and the first is not what its name suggests:
	 *
	 *   - **`ctx.hasUI`** does **not** mean "a human is watching". Measured against
	 *     the real CLI: a `pi --mode rpc` child reports `hasUI: true` (that surface
	 *     is how its parent drives it), while a one-shot `pi -p …` reports `false`.
	 *     So it already means "a live, ongoing session", which is exactly the
	 *     question being asked here — and it is *not* the same question as the mail
	 *     delivery rule, which genuinely asks whether a human is present.
	 *   - **`-p` / `--print` in argv**, as defence in depth. Belt and braces because
	 *     getting this wrong in the permissive direction re-creates the hang, and a
	 *     future pi could plausibly report `hasUI: true` for a print run.
	 *
	 * `--list-models` needs no handling: measured, it never fires `session_start`
	 * at all, so this function is never reached for it.
	 */
	function isRealAgentSession(): boolean {
		if (!parentHasUI()) return false;
		const argv = process.argv.slice(1);
		if (argv.includes("-p") || argv.includes("--print")) return false;
		return true;
	}

	/**
	 * Steer mail into the turn already running.
	 *
	 * For mail that says something is *stopped* — a child blocked in `ask_parent`,
	 * a stalled child, an auto-resume that has given up. A turn can run for
	 * minutes and none of those get better while it does; steering lands between
	 * tool calls instead of after.
	 *
	 * Falls back to arming the settle path if the host will not take a steer: a
	 * failed steer must degrade to "late" and never to "lost".
	 */
	function steerParent(): void {
		const mail = takeMail(manager.mailbox);
		if (!mail) return;
		try {
			pi.sendMessage(
				{ customType: "subagents", content: mail.content, display: true },
				{ deliverAs: "steer" },
			);
		} catch {
			returnMail(manager.mailbox, mail.events);
			wakeWhenIdle = true;
		}
	}

	/**
	 * Deferred so several children finishing at once produce one turn, and so a
	 * wake requested from inside `agent_settled` starts its turn after that event
	 * has finished being dispatched.
	 */
	function scheduleWake(): void {
		if (wakeTimer) return;
		wakeTimer = setTimeout(() => {
			wakeTimer = undefined;
			wakeParent();
		}, 0);
		wakeTimer.unref?.();
	}

	function wakeParent(): void {
		// Re-checked: something may have started a turn since the wake was queued.
		// With a human that is fine — the mail rides in with whatever they sent. With
		// no human it is not: re-arming the settle path is the only thing standing
		// between the queue and never being delivered.
		if (!parentIsIdle()) {
			if (!parentHasUI() && manager.mailbox.size > 0) wakeWhenIdle = true;
			return;
		}
		const mail = takeMail(manager.mailbox);
		if (!mail) return;
		wakeWhenIdle = false;
		try {
			pi.sendMessage(
				{ customType: "subagents", content: mail.content, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			returnMail(manager.mailbox, mail.events);
		}
	}

	pi.on("before_agent_start", async (event, ctx) => {
		uiContext = ctx;
		const mail = takeMail(manager.mailbox);
		const result: { message?: any; systemPrompt?: string } = {};

		if (mail) {
			wakeWhenIdle = false;
			result.message = { customType: "subagents", content: mail.content, display: true };
		}
		if (settings.orchestrate !== "off") {
			const guidance = orchestratorPrompt();
			if (guidance) result.systemPrompt = `${event.systemPrompt}\n\n${guidance}`;
		}
		return result;
	});

	/**
	 * The turn ended, so the queue drains. This is the load-bearing delivery path.
	 *
	 * It used to fire only when `wakeWhenIdle` had been armed *and*
	 * `onFinish === "wake"`, which made it a special case layered on top of "the
	 * mail rides into the next request". That was the nesting bug: "next request"
	 * means "when a user types", and an intermediate parent in a nested tree is a
	 * headless `pi --mode rpc` process that no user will ever type into. Its
	 * queue was not delivered late — it was never delivered.
	 *
	 * So a turn ending now drains anything self-driving that is queued, whether or
	 * not anybody armed anything. `report` alone still rides, because a chatty
	 * child starting a parent turn every few seconds is the thing that would
	 * destroy "spawning does not block you".
	 *
	 * `onFinish` deliberately does **not** gate this. It decides whether a result
	 * may *interrupt* — start a turn while the parent is idle — which is a
	 * question about attention, not about whether the result is ever handed over.
	 * Reading it as "never deliver" is how `notify` stranded results forever, and
	 * it is the same mistake as "ride into the next request" one setting along.
	 */
	pi.on("agent_settled", async (_event, ctx) => {
		uiContext = ctx;
		const queued = manager.mailbox.peek();
		if (queued.length === 0) {
			wakeWhenIdle = false;
			return;
		}
		// A turn has just ended, so nothing is being interrupted: everything
		// actionable goes now, whatever `onFinish` says and whoever is watching.
		if (!queued.some((event) => selfDriving(event.kind)) && !wakeWhenIdle) return;
		scheduleWake();
	});

	pi.on("tool_call", async (event) => {
		if (settings.orchestrate !== "strict") return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		return {
			block: true,
			reason:
				"Orchestrator mode is strict: delegate file changes to a subagent " +
				'(subagent action:"spawn" with its own cwd) instead of editing here. ' +
				"Use /agents orchestrate nudge to relax this.",
		};
	});

	// ----------------------------------------------------------------- tool ---

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate work to child agents that run in their own conversation, process and working " +
			"directory. Spawning is non-blocking: the child works while you keep going, and its " +
			"results are delivered to you automatically.\n\n" +
			"Actions:\n" +
			"- spawn: start a child. Requires name and task. Optional persona, cwd, context, model, tools, mcp_servers.\n" +
			"- message: queue extra context for a child without interrupting it.\n" +
			"- followup: give a running child new instructions, or resume a finished one.\n" +
			"- list: show every child and its state.\n" +
			"- read: return a child's latest output without resuming it.\n" +
			"- notes: read or append the shared mission notes every agent can see.\n" +
			"- interrupt: stop a child's current turn but keep its conversation.\n" +
			"- answer: reply to a child that asked you a question and is blocked waiting.\n" +
			"- retry: recover a stalled child (e.g. after a network drop) on its existing conversation.\n" +
			"- mcp: change which MCP servers a child boots, with mcp_servers. Applies from the child's " +
			"next revive, not immediately \u2014 servers are connected at process startup, so a running child " +
			"keeps its current set until it hibernates and comes back.\n" +
			"- close: end a child and free its slot.",
		promptSnippet: "Delegate a task to a child agent with its own context and working directory",
		promptGuidelines: [
			"Use subagent spawn for self-contained units of work; it returns immediately and does not block the conversation.",
			"Give each subagent its own cwd when the project uses a worktree-per-task workflow.",
		],
		parameters: Type.Object({
			action: StringEnum([
				"spawn",
				"message",
				"followup",
				"list",
				"read",
				"notes",
				"interrupt",
				"answer",
				"retry",
				"mcp",
				"close",
			] as const),
			name: Type.Optional(Type.String({ description: "Child name (spawn) or target child" })),
			task: Type.Optional(Type.String({ description: "The task for a spawned child" })),
			task_summary: Type.Optional(
				Type.String({
					description:
						"One-line label for the task, shown in listings. Defaults to the task's first line; " +
						"worth setting when several children share a similar opening.",
				}),
			),
			message: Type.Optional(Type.String({ description: "Text for message/followup/notes append" })),
			persona: Type.Optional(Type.String({ description: "Persona name from your agents directory" })),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the child, e.g. a git worktree path" }),
			),
			context: Type.Optional(
				StringEnum(["auto", "fresh", "compacted", "forked"] as const, {
					description: "How much parent context the child inherits (default auto)",
				}),
			),
			model: Type.Optional(Type.String({ description: "Model override, e.g. anthropic/claude-sonnet-4-5" })),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for the child" })),
			mcp_servers: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"MCP servers this child may boot, by name; [\"*\"] for all, [] for none. " +
						"An allowlist: children boot no servers unless listed, so scope a child to " +
						"only what its task needs. Used by spawn (at creation) and by the mcp action " +
						"(which takes effect on the child's next revive).",
				}),
			),
			notes_action: Type.Optional(StringEnum(["read", "append"] as const)),
		}),

		// Without these pi falls back to a bold tool name in the error-styled shell,
		// so every action looks the same and the delegated task text — a prompt handed
		// to another process with these credentials — is never shown. See render.ts.
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,

		/**
		 * `signal` is threaded into every manager call that can wait.
		 *
		 * It is the only lever pi has to stop this tool: without it, Escape sets a
		 * flag nobody reads and the session is stuck behind whatever we are awaiting.
		 * See the liveness invariant at the top of manager.ts / rpc.ts.
		 */
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Kept live: this is the context that tells us whether the parent is idle
			// when a child finishes, and children only exist because of this tool.
			uiContext = ctx;
			const personas = discoverPersonas(
				ctx.cwd,
				// Fail closed: a persona is an instruction file that runs with your
				// credentials, so an absent trust API must not mean "trusted".
				settings.projectPersonas && ctx.isProjectTrusted?.() === true,
			);

			switch (params.action) {
				case "spawn": {
					claimRoot();
					const agent = await manager.spawn(
						ctx,
						personas,
						{
							name: String(params.name ?? ""),
							task: String(params.task ?? ""),
							...(params.task_summary ? { taskSummary: String(params.task_summary) } : {}),
							persona: params.persona,
							cwd: params.cwd,
							context: params.context as any,
							model: params.model,
							tools: params.tools,
							mcpServers: params.mcp_servers,
							// A spawn can spend a full LLM summarization before the child even
							// exists; without this it reads as a hang. See progress.ts.
							onUpdate,
						},
						signal,
					);
					return {
						content: [
							{
								type: "text",
								text:
									`Spawned "${agent.name}" (${agent.contextMode} context` +
									`${agent.persona ? `, persona ${agent.persona}` : ""}) in ${agent.cwd}.\n` +
									"It is running now; keep working. Its result will be delivered to you automatically." +
									(agent.reclaimedToStart
										? `\n\nAll slots were taken, so "${agent.reclaimedToStart}" — the least ` +
											"recently active finished subagent — was closed to make room. Close finished " +
											"agents yourself once you have verified their work."
										: ""),
							},
						],
						details: {
							agent: agent.name,
							cwd: agent.cwd,
							contextMode: agent.contextMode,
							...(agent.reclaimedToStart ? { reclaimed: agent.reclaimedToStart } : {}),
						},
					};
				}

				case "message":
				case "followup": {
					const text = String(params.message ?? "").trim();
					if (!text) throw new Error(`${params.action} requires a message`);
					const agent = await manager.send(
						String(params.name ?? ""),
						text,
						params.action === "message" ? "followUp" : "steer",
						{ signal },
					);
					return {
						content: [{ type: "text", text: `Delivered to "${agent.name}".` }],
						details: { agent: agent.name },
					};
				}

				case "answer": {
					const text = String(params.message ?? "").trim();
					if (!text) throw new Error("answer requires a message");
					const { agent, delivered } = await manager.answer(String(params.name ?? ""), text);
					if (delivered) {
						return {
							content: [
								{ type: "text", text: `Answered "${agent.name}"; it has resumed where it left off.` },
							],
							details: { agent: agent.name, delivered: true },
						};
					}
					// No question outstanding — the child may have been interrupted, or the
					// orchestrator may just be volunteering something. Losing the text
					// would be the worst option, so it becomes ordinary input.
					await manager.send(agent.id, text, agent.busy ? "steer" : "followUp", { signal });
					return {
						content: [
							{
								type: "text",
								text:
									`"${agent.name}" had no question outstanding, so this was delivered as a ` +
									"normal message instead.",
							},
						],
						details: { agent: agent.name, delivered: false },
					};
				}

				case "retry": {
					const { agent, revived } = await manager.retry(
						String(params.name ?? ""),
						params.message ? String(params.message) : undefined,
						{ signal },
					);
					return {
						content: [
							{
								type: "text",
								text:
									`Re-prompted "${agent.name}" on its existing conversation` +
									`${revived ? " (its process was wedged, so it was restarted)" : ""}. ` +
									"Nothing it had already done was lost.",
							},
						],
						details: { agent: agent.name, revived },
					};
				}

				case "mcp": {
					if (!Array.isArray(params.mcp_servers)) {
						// An absent list is ambiguous between "no servers" and "I forgot the
						// argument", and guessing the first would silently strip a child.
						throw new Error('mcp requires mcp_servers (use [] for none, ["*"] for all)');
					}
					const { agent, pending } = manager.setMcpScope(
						String(params.name ?? ""),
						params.mcp_servers as string[],
					);
					const scope = agent.launch.mcpScope ?? [];
					const listed = scope.length ? scope.join(", ") : "no servers";
					return {
						content: [
							{
								type: "text",
								text:
									`"${agent.name}" is now scoped to ${listed}.` +
									// Never claim a hot swap: MCP servers are connected while the
									// child's process boots, from the environment it was launched
									// with, so a running child is still on its old set.
									(pending
										? " It is running, so this applies from its next revive \u2014 it " +
											"keeps its current servers until then. Nothing needs doing: it " +
											"hibernates on idle and picks the new scope up when you next " +
											"message it."
										: " It has no process right now, so this takes effect the moment " +
											"it is revived."),
							},
						],
						details: { agent: agent.name, mcpServers: scope, appliesOnNextRevive: pending },
					};
				}

				case "list": {
					const agents = manager.snapshots();
					// Surfaced alongside the live set: after a cold start these are the only
					// delegated work that exists, and the orchestrator cannot ask for them
					// back if nothing tells it they are there.
					const previous = restorableSummary();
					if (agents.length === 0) {
						return {
							content: [
								{
									type: "text",
									text:
										`No subagents. Available personas: ${describePersonas(personas)}` +
										(previous ? `\n\n${previous}\n${RESTORABLE_NOTE}` : ""),
								},
							],
							details: { agents: [], ...(previous ? { restorable: restorable.length } : {}) },
						};
					}
					const text = agents
						.map((a) => {
							const note = a.pendingQuestion
								? ` — BLOCKED waiting for your answer: "${a.pendingQuestion.question.slice(0, 100)}"`
								: a.status === "stalled"
									? ` — silent ${describeSilence(a.silentForMs ?? 0)} (use action:"retry")`
									: a.status === "hibernated"
										? " — no process; sending to it resumes its conversation"
										: "";
							return (
								`${manager.statusIcon(a.status)} ${a.name} — ${a.status}${note} — ${a.usage.turns} turns — ` +
								`${formatCost(a.usage.cost)} — cwd ${a.cwd}\n    task: ${a.taskSummary || a.task}`
							);
						})
						.join("\n");
					return {
						content: [
							{
								type: "text",
								text:
									text +
									(previous ? `\n\n${previous}\n${RESTORABLE_NOTE}` : ""),
							},
						],
						details: { agents, ...(previous ? { restorable: restorable.length } : {}) },
					};
				}

				case "read": {
					const agent = manager.require(String(params.name ?? ""));
					manager.mailbox.drain(agent.id); // Avoid delivering the same text twice.
					const silentFor = manager.silentFor(agent);
					// Said before the output: a stalled child's last text looks like a
					// finished answer, and acting on it as if it were one is the failure
					// mode this whole feature exists to prevent.
					const prefix = agent.pendingQuestion
						? `["${agent.name}" is blocked waiting for you to answer: ` +
							`"${agent.pendingQuestion.question}". Reply with ` +
							`subagent{action:"answer",name:"${agent.name}",message:"…"}.]\n\n`
						: agent.status === "stalled"
							? `["${agent.name}" is stalled: no activity for ${describeSilence(silentFor ?? 0)}. ` +
								`Its work is not finished; subagent action:"retry" name:"${agent.name}" resumes it.]\n\n`
							: agent.status === "hibernated"
								? `["${agent.name}" is hibernated (the parent reloaded). Its conversation is intact; ` +
									"sending it a message resumes it.]\n\n"
								: "";
					return {
						content: [
							{
								type: "text",
								text:
									prefix +
									(agent.output || `"${agent.name}" has not produced output yet (${agent.status}).`),
							},
						],
						details: {
							agent: agent.name,
							status: agent.status,
							usage: agent.usage,
							...(silentFor === undefined ? {} : { silentForMs: silentFor }),
						},
					};
				}

				case "notes": {
					const notesPath = manager.sharedNotesPath(String(ctx.sessionManager.getSessionId()));
					if ((params.notes_action ?? "read") === "read") {
						const content = readNotes(notesPath);
						return {
							content: [{ type: "text", text: content.trim() || "(shared notes are empty)" }],
							details: { path: notesPath },
						};
					}
					const text = String(params.message ?? "").trim();
					if (!text) throw new Error("notes append requires a message");
					// O_APPEND: children append to this same file from other processes.
					appendNote(notesPath, "parent", text);
					return {
						content: [{ type: "text", text: "Appended to shared notes." }],
						details: { path: notesPath },
					};
				}

				case "interrupt": {
					// Synchronous by design. This call is what froze a whole session when it
					// awaited an acknowledgement the child never sent; see the comment on
					// `SubagentManager.interrupt`.
					const agent = manager.interrupt(String(params.name ?? ""), { signal });
					return {
						content: [{ type: "text", text: `Interrupted "${agent.name}"; its conversation is kept.` }],
						details: { agent: agent.name },
					};
				}

				case "close": {
					const target = manager.require(String(params.name ?? ""));
					forgetChatPane(target.id);
					const agent = await manager.close(String(params.name ?? ""));
					return {
						content: [{ type: "text", text: `Closed "${agent.name}".` }],
						details: { agent: agent.name },
					};
				}

				default:
					throw new Error(`unknown action: ${String(params.action)}`);
			}
		},
	});

	// ------------------------------------------------------------- commands ---

	// Commands are UI: they appear in the human's slash menu, and a child has no
	// human. Registering them inside a subagent would also mean the child's model
	// could see them, which is not the interface it is meant to have.
	if (registersUi) pi.registerCommand("agents", {
		description: "Open a subagent chat, restore agents from a previous run, or change orchestrator mode",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "orchestrate off", label: "orchestrate off" },
				{ value: "orchestrate nudge", label: "orchestrate nudge" },
				{ value: "orchestrate strict", label: "orchestrate strict" },
				{ value: "notes", label: "notes" },
				{ value: "restore", label: "restore", description: "agents from a previous run" },
				{
					value: "mail",
					label: "mail",
					description: "which state changes reach the orchestrator",
				},
				...manager.list().map((a) => ({ value: a.name, label: a.name, description: a.status })),
			].filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			uiContext = ctx;
			const trimmed = args.trim();

			if (trimmed === "restore") {
				restoreFromRegistry(ctx);
				return;
			}

			if (trimmed.startsWith("orchestrate")) {
				const mode = trimmed.split(/\s+/)[1] as OrchestrateMode | undefined;
				if (!mode || !["off", "nudge", "strict"].includes(mode)) {
					ctx.ui.notify(`orchestrator mode: ${settings.orchestrate}`, "info");
					return;
				}
				settings = { ...settings, orchestrate: mode };
				saveSettings(settings);
				ctx.ui.notify(`orchestrator mode: ${mode}`, "info");
				return;
			}

			// The transition table, verbatim. "Why was I not told about that?" is
			// answerable without reading the source — and a rule nobody can inspect is a
			// rule nobody notices is missing.
			if (trimmed === "mail") {
				await openTextOverlay(
					ctx.ui,
					"subagent mail — which state changes reach the orchestrator",
					describeTransitionTable(),
				);
				return;
			}

			if (trimmed === "notes") {
				const notesPath = manager.sharedNotesPath(String(ctx.sessionManager.getSessionId()));
				const content = readNotes(notesPath);
				await openTextOverlay(ctx.ui, `shared notes — ${notesPath}`, content.trim() || "(empty)");
				return;
			}

			await openChat(ctx, trimmed || undefined);
		},
	});

	// No shortcut is registered on purpose: `ctrl+g` is pi's own
	// `app.editor.external` binding, and shadowing it cost more than the shortcut
	// was worth. The strip (`↓` out of an empty input) and `/agents [name]` are
	// the two ways in.

	// ------------------------------------------------------------ lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		uiContext = ctx;
		settings = loadSettings();
		const identity = sessionIdentity(ctx);
		// The `subagents-restore` footer entry is gone. It was a persistent "1
		// restorable subagent" nagging about work that is now adopted automatically,
		// on a footer line shared with every other extension. Cleared explicitly
		// rather than merely no longer written: a reload keeps whatever the previous
		// incarnation of this extension left in the status bar, so a session started
		// on the old code would carry the stale entry forever.
		if (registersUi && ctx.hasUI) {
			try {
				ctx.ui.setStatus("subagents-restore", undefined);
			} catch {
				/* headless */
			}
		}
		manager.setConfig({
			registry,
			// Every child spawned from here records this as its parent, which is what
			// makes the registry a tree rather than a flat list.
			parentSessionId: identity.sessionId,
			// And this is what lets a *later* pi tell its own leftovers from another
			// project's: one registry file describes every tree on the machine.
			parentCwd: sessionCwdOf(ctx),
			childDeny: settings.childDeny,
			childMcpServers: settings.childMcpServers,
			stallSeconds: settings.stallSeconds,
			idleHibernateMinutes: settings.idleHibernateMinutes,
			autoResumeMaxAgeMinutes: settings.autoResumeMaxAgeMinutes,
			maxResumeAttempts: settings.maxResumeAttempts,
		});
		// A key that stopped meaning anything, sitting in a config the user still
		// edits, is worse than no key at all: it reads as configuration. Said once
		// per session, at the only point where there is a UI to say it into.
		for (const key of obsoleteSettingKeys()) {
			try {
				ctx.ui?.notify(
					`subagents: "${key}" in ${settingsPath()} no longer does anything — ` +
						`${OBSOLETE_SETTINGS[key]}`,
					"warning",
				);
			} catch {
				/* headless */
			}
		}
		// The root is claimed lazily, on the first spawn (see `claimRoot`). Doing it
		// here would mean every `pi` launch — including `--list-models` — rewrote the
		// registry, and the last session to start would own a tree it has no children
		// in.
		rootSessionId = identity.isChild ? undefined : identity.sessionId;
		rootClaimed = false;
		restoreHibernated(ctx);
		surveyRegistry(ctx, identity);
		// After both restore paths have populated the manager, so one sweep covers a
		// reload and a cold start alike. Deliberately not awaited: a session must not
		// wait on child processes starting, and every failure inside is contained per
		// agent and reported through the mailbox.
		resumeInFlight = resumeInterruptedWork(resumeAbort.signal);
		// A reload resets the custom editor, so it is installed here rather than
		// once at load time. Behaviour is identical to the stock editor until a
		// child exists.
		if (registersUi && ctx.hasUI) {
			ctx.ui.setEditorComponent(
				subagentsEditorFactory({
					strip,
					agentCount: () => manager.list().length,
					// Read per frame, not captured: `ui.theme` is a live getter and `/theme`
					// replaces the object, and there is no theme-change event to listen for.
					badgeTheme: () => {
						try {
							return uiContext?.ui?.theme;
						} catch {
							return undefined;
						}
					},
					onCreate: (editorTui, created) => {
						tui = editorTui;
						// The outgoing instance is released *after* the new one has registered,
						// which is why `setRenderer` counts rather than flags: for that moment
						// two editors exist and the bar is genuinely still being drawn.
						releaseEditor();
						editor = created;
					},
				}),
			);
		}
		// Only the transition matters. Subscribing to badge changes as well would mean
		// reacting to this extension's own `publish` on every child event — harmless,
		// since an unchanged republish notifies nobody, but a repaint nobody asked for.
		rendererPresent = hasRenderer();
		unwatchRenderer?.();
		unwatchRenderer = subscribe(() => {
			const present = hasRenderer();
			if (present === rendererPresent) return;
			rendererPresent = present;
			// Writes the footer sentence when the bar has gone, clears it when it arrives.
			refreshUi();
		});
		refreshUi();
	});

	/**
	 * Bring back the children the previous incarnation of this extension left.
	 *
	 * The records live in the parent's own session, so a reload (same session
	 * file) finds them and a freshly opened session does not. Failing here must
	 * never stop the session from starting: the worst case is the old behaviour.
	 */
	/** The parent session id, or undefined when there is no session to ask. */
	function sessionIdOf(ctx: any): string | undefined {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id ? id : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The directory this session is working in.
	 *
	 * `ctx.cwd` is the contract; the session header is the fallback for a context
	 * that has already been torn down. Undefined rather than `process.cwd()` when
	 * neither answers: guessing here would scope auto-restore to wherever the pi
	 * binary happened to be launched from, and adopting the wrong project's agents
	 * is the one outcome this value exists to prevent.
	 */
	function sessionCwdOf(ctx: any): string | undefined {
		try {
			if (typeof ctx?.cwd === "string" && ctx.cwd) return ctx.cwd;
			const header = ctx?.sessionManager?.getHeader?.();
			return typeof header?.cwd === "string" && header.cwd ? header.cwd : undefined;
		} catch {
			return undefined;
		}
	}

	function restoreHibernated(ctx: any): void {
		try {
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			const records = collectRecords(entries, sessionIdOf(ctx));
			if (hasHibernateEntry(entries)) restoredFromSession = true;
			if (records.length === 0) return;
			const restored = manager.restore(records);
			if (restored.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`restored ${restored.length} subagent${restored.length === 1 ? "" : "s"}: ` +
						`${restored.map((a) => a.name).join(", ")} — message one to resume it`,
					"info",
				);
			}
		} catch {
			/* a session without readable entries simply has nothing to restore */
		}
	}

	/**
	 * Restart work that a reload or a crash interrupted.
	 *
	 * The framework's half of the promise. An agent that was mid-task when its
	 * process went away is picked back up here without anybody asking; an agent
	 * that had **finished** is left alone, because the idle sweep stopped it on
	 * purpose and restarting it would redo the work.
	 *
	 * Two triggers, one difference: a reload knows the process was alive moments
	 * ago, so age is irrelevant. A cold start (`kill pi && pi`) cannot know that,
	 * so it only resumes work younger than `autoResumeMaxAgeMinutes`; anything
	 * older stays behind the `/agents restore` affordance exactly as before.
	 *
	 * **This function starts processes**, which is why the guards below are not
	 * optional. `session_start` fires for `--list-models`, `-p`, and every other
	 * non-interactive invocation, and "a tool that starts processes because you
	 * launched it is a tool people stop launching". Resuming is worth the exception
	 * only for a real, interactive session that is going to supervise the work it
	 * restarts.
	 *
	 * It resumes what is **in the manager**, and nothing else. On a cold start that
	 * is whatever `surveyRegistry` decided belongs to this directory, which is the
	 * scoping guarantee: an interrupted child of a different project is not
	 * restarted from here — it is restarted by the next pi opened *there*, which
	 * will find it exactly the same way. This used to reach into the leftovers the
	 * survey had rejected and resume any unfinished one wherever it came from,
	 * which meant opening pi in one repo could start a `pi --mode rpc` editing
	 * files in another.
	 */
	async function resumeInterruptedWork(signal: AbortSignal): Promise<void> {
		try {
			if (settings.autoResume === false) return;
			if (signal.aborted) return;
			// Deliberately takes no identity and is NOT gated on being a child. A nested
			// parent — a `pi --mode rpc` process with children of its own — must resume
			// its own interrupted work, or an interrupted grandchild is stranded
			// permanently with nobody able to revive it. That is the same "wait for
			// someone who is never coming" bug as the delivery one.
			//
			// (`surveyRegistry` *does* still return early for a child, and must: adopting
			// registry orphans is a different act from resuming your own children, and
			// it is the one that would put two `pi` processes on one session file.)
			if (!isRealAgentSession()) return;
			// A reload continued the same session (its records came out of the
			// transcript); anything else is a new process that found the registry — and
			// `surveyRegistry` has already put this directory's share of it into the
			// manager, so there is nothing to adopt here.
			const trigger = restoredFromSession ? "reload" : "cold-start";

			const { resumed, gaveUp } = await manager.autoResume(trigger, Date.now(), signal);
			if (resumed.length === 0 && gaveUp.length === 0) return;
			// The orchestrator already heard about both through the mailbox (the
			// transition table publishes `resumed` and `error`). This is the human's
			// copy, and only the human's.
			if (registersUi && uiContext?.hasUI) {
				if (resumed.length > 0) {
					uiContext.ui.notify(
						`resumed ${resumed.length} interrupted subagent${resumed.length === 1 ? "" : "s"}: ` +
							`${resumed.map((a) => a.name).join(", ")}`,
						"info",
					);
				}
				for (const agent of gaveUp) {
					uiContext.ui.notify(
						`subagent ${agent.name} keeps dying on resume and has been left failed — read it before retrying`,
						"error",
					);
				}
			}
			refreshUi();
		} catch {
			/* auto-resume is recovery: failing to recover must not break the session */
		}
	}

	/**
	 * What the registry says survived, after a cold start — and what to do with it.
	 *
	 * This is the case session-entry hibernation structurally cannot cover: `kill
	 * pi` and start again opens a *new* session, so nothing in the old session
	 * file is ever read. The registry lives outside sessions precisely so this
	 * path exists.
	 *
	 * ## Why this now adopts instead of asking
	 *
	 * It used to only report — a toast and a permanent `1 restorable subagent` in
	 * the footer — and leave the decision to `/agents restore`. The caution was
	 * aimed at the right danger and applied to the wrong act: **restoring starts
	 * no processes**. It turns registry rows back into records in a list, which a
	 * `close` undoes. Spawning is a separate decision made in `resumeInterrupted-
	 * Work` under an age bound and a retry cap, and it stays exactly as strict.
	 *
	 * So the affordance was asking the human to press a button whose only effect
	 * they already wanted, on every launch, forever. If something is restorable it
	 * should simply be restored.
	 *
	 * ## What is still not automatic, and why
	 *
	 *   - **Another project's children.** One registry file describes every tree on
	 *     the machine. Adopting `~/work/other-repo`'s agents into this session
	 *     would show them in a switcher they have nothing to do with, and a message
	 *     to one would start a process in a directory nobody is looking at.
	 *   - **Anything older than `autoRestoreMaxAgeMinutes`** (a day). Without an age
	 *     bound a registry that has accumulated leftovers resurrects the same pile
	 *     at every launch until they are closed one at a time.
	 *   - **One-shot invocations.** `pi -p …` gets a `session_start` too, and
	 *     folding somebody else's agents into a single scripted turn is neither
	 *     wanted nor observable.
	 *   - **A child another pi is still driving.** Two windows on one repo share a
	 *     directory, so scoping cannot tell them apart; a surviving pid can.
	 *
	 * Whatever is left lands in `restorable`, and `/agents restore` still takes it
	 * — an explicit request may reach across directories, because somebody asked.
	 */
	function surveyRegistry(ctx: any, identity: { sessionId?: string; isChild: boolean }): void {
		try {
			// A nested agent surveys nothing. The tree in the registry belongs to the
			// root, and a child offering to adopt its own siblings — or its parent's
			// other children — would put two `pi` processes on one session file.
			if (identity.isChild) return;
			// `live()` reconciles pids first: after a crash every status in the file
			// is frozen at the moment of the crash, and a node whose pid nobody can
			// signal is hibernated whatever it claims.
			const file = registry.live();
			// Anything this session already restored from its own entries is not news.
			const known = new Set(
				manager.list().flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])),
			);
			const orphans = restorableNodes(file.nodes)
				.filter((node) => !known.has(node.sessionId))
				// A node this very session is the parent of would already be in the
				// manager; anything else belongs to a parent that is gone.
				.filter((node) => node.sessionId !== identity.sessionId)
				// `live()` cleared the pid of everything that is not running, so a pid
				// that survived is a process somebody is driving *right now* — two pi
				// windows open on one repo is all it takes. Adopting it would put two
				// parents on one session file. Cheap to check and the one hazard that
				// scoping by directory cannot see, since both windows share a directory.
				.filter((node) => node.pid === undefined)
				// A node whose recorded parent is still alive is somebody else's to
				// revive; only orphans are ours to adopt.
				.filter((node) => !isLiveElsewhere(node, file.nodes));
			if (orphans.length === 0) {
				restorable = [];
				return;
			}
			// Computed over *every* node, not just the orphans, so a grandchild whose
			// own parent was already restored from this session's entries still finds
			// its seed. The orphan filters above are then what decides adoption.
			const mine = isRealAgentSession()
				? new Set(
						autoRestorable(file.nodes, {
							cwd: sessionCwdOf(ctx),
							now: Date.now(),
							maxAgeMinutes: settings.autoRestoreMaxAgeMinutes,
						}).map((node) => node.sessionId),
					)
				: new Set<string>();
			restorable = orphans.filter((node) => !mine.has(node.sessionId));
			adoptPreviousRun(
				ctx,
				orphans.filter((node) => mine.has(node.sessionId)),
			);
			if (restorable.length > 0 && registersUi && ctx?.hasUI) {
				// Said once, as a toast, and never as a footer entry: these are agents
				// this session decided are not its own, so the human is being told what
				// exists rather than nagged about a chore.
				ctx.ui.notify(
					`${restorable.length} subagent${restorable.length === 1 ? "" : "s"} from another ` +
						"directory or an older run were left alone — /agents restore adopts them",
					"info",
				);
			}
		} catch {
			/* a bad registry must never keep a session from starting */
		}
	}

	/**
	 * Take this directory's previous run back, without making a scene.
	 *
	 * No process is started here — `manager.restoreFromRegistry` produces records,
	 * and `resumeInterruptedWork` is what decides which of them are worth a `pi`
	 * process. What this does is make them *exist* again: visible in the switcher,
	 * readable in a chat pane, closable, and known to the orchestrator the next
	 * time it runs.
	 *
	 * Quiet is the whole point (see `adoptingQuietly`): one summary toast instead
	 * of one per agent, and no model turn started before the human has typed.
	 */
	function adoptPreviousRun(ctx: any, nodes: readonly RegistryNode[]): void {
		if (nodes.length === 0) return;
		let restored: ReturnType<typeof manager.restoreFromRegistry> = [];
		adoptingQuietly = true;
		try {
			restored = manager.restoreFromRegistry(nodes);
		} finally {
			// A `finally`, not a line after the call: leaving this set would silence
			// every piece of mail for the rest of the session, which is the failure
			// mode this extension exists to prevent.
			adoptingQuietly = false;
		}
		if (restored.length === 0) return;
		if (registersUi && ctx?.hasUI) {
			try {
				ctx.ui.notify(
					`restored ${restored.length} subagent${restored.length === 1 ? "" : "s"} from the ` +
						`previous run: ${restored.map((agent) => agent.name).join(", ")}`,
					"info",
				);
			} catch {
				/* headless */
			}
		}
		refreshUi();
	}

	/** `/agents restore`: adopt the previous run's children into this session. */
	function restoreFromRegistry(ctx: any): void {
		if (restorable.length === 0) {
			ctx.ui.notify("No subagents from a previous run are restorable", "info");
			return;
		}
		const restored = manager.restoreFromRegistry(restorable);
		// Cleared whatever happened: a node whose session file vanished between the
		// survey and now is not going to become restorable by asking again.
		restorable = [];
		ctx.ui.notify(
			restored.length === 0
				? "Nothing could be restored: their session files are gone"
				: `Restored ${restored.length} subagent${restored.length === 1 ? "" : "s"}: ` +
					`${restored.map((a) => a.name).join(", ")} — message one to resume it`,
			restored.length === 0 ? "warning" : "info",
		);
		refreshUi();
	}

	/**
	 * Whether some *other* running agent already owns this node.
	 *
	 * A tree can outlive one of its parents without outliving all of them: if the
	 * node's recorded parent still has a live pid, that parent is the one that will
	 * revive it, and adopting it here would put two `pi` processes on one session
	 * file.
	 */
	function isLiveElsewhere(node: RegistryNode, nodes: readonly RegistryNode[]): boolean {
		if (!node.parentSessionId) return false;
		const parent = nodes.find((other) => other.sessionId === node.parentSessionId);
		// `nodes` came from `live()`, so a surviving pid here means a real process.
		return parent?.pid !== undefined;
	}

	/** Human-readable form of the survey, for the `list` action. */
	function restorableSummary(): string | undefined {
		return restorable.length === 0 ? undefined : describeRestorable(restorable);
	}

	/**
	 * Teardown.
	 *
	 * Only quitting kills the children. A reload used to as well, which is why
	 * `/reload` had become unusable: three separate batches of delegated work
	 * were destroyed by pressing it. Now the live set is written into the session
	 * first (`pi.appendEntry`, so it survives the runtime being torn down) and the
	 * processes are stopped in parallel under a short deadline, so the reload is
	 * fast as well as non-destructive.
	 */
	/**
	 * Hand back the current editor's badge subscription and renderer vote.
	 *
	 * Safe to call when there is no editor and safe to call twice: `dispose()` is
	 * idempotent per instance, which is what keeps the renderer count honest when a
	 * reload disposes the same instance from both here and `onCreate`.
	 */
	function releaseEditor(): void {
		try {
			editor?.dispose();
		} catch {
			/* it is going away regardless */
		}
		editor = undefined;
	}

	pi.on("session_shutdown", async (event: any) => {
		// First, and unconditionally: publishers ask `hasRenderer()` before deciding
		// to skip their own status line, and an editor that is being torn down is not
		// drawing anything. Leaving the vote behind would silence the MCP indicator
		// everywhere for the rest of the process.
		releaseEditor();
		try {
			unwatchRenderer?.();
		} catch {
			/* the store has already forgotten us */
		}
		unwatchRenderer = undefined;
		// Withdraw this extension's own chip, for the reason mcp withdraws its own: a
		// bar left holding the last snapshot would spend the end of the session
		// reporting agents that are in the middle of being stopped.
		publish("subagents", undefined);
		if (wakeTimer) clearTimeout(wakeTimer);
		wakeTimer = undefined;
		wakeWhenIdle = false;
		if (stallTimer) clearInterval(stallTimer);
		stallTimer = undefined;
		disposeChatPanes();
		// Stop auto-resume launching anything else, and let the launch already in
		// flight finish handing its process over — bounded, because a teardown that
		// waits on a child starting is the freeze this extension keeps re-learning.
		// Without this a shutdown races the resume loop and the children it was
		// mid-way through spawning are never registered with anybody.
		resumeAbort.abort();
		if (resumeInFlight) {
			await Promise.race([
				resumeInFlight.catch(() => undefined),
				new Promise((resolve) => setTimeout(resolve, 2_000).unref?.()),
			]);
			resumeInFlight = undefined;
		}
		// A reload starts a new session_start, which needs a fresh controller.
		resumeAbort = new AbortController();

		if (shutdownPolicy(event?.reason) === "stop") {
			// `quit` still stops the processes — nobody is coming back for *this* pi —
			// but it no longer discards them. `stopAll` checkpoints the registry before
			// the kill, so the next cold start finds the conversations and offers them
			// back instead of stranding them on disk.
			await manager.stopAll();
			return;
		}
		// Written *before* the processes are stopped: if the kill hangs and the
		// runtime is torn down under us, the records are already in the session.
		// An empty payload is still written once there has ever been one, because
		// "newest entry wins" is how a closed agent stops being restored.
		if (manager.list().length > 0 || restoredFromSession) {
			try {
				pi.appendEntry(
					HIBERNATE_ENTRY_TYPE,
					buildPayload(manager.list(), sessionIdOf(uiContext)),
				);
			} catch {
				// Nothing can be persisted; stopping is still better than orphaning.
			}
		}
		await manager.hibernateAll();
	});
}

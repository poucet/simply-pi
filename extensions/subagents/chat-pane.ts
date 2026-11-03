/**
 * One chat pane per subagent.
 *
 * This is deliberately *not* a bespoke transcript renderer: it builds the very
 * same components pi's interactive mode builds for the main chat
 * (`UserMessageComponent`, `AssistantMessageComponent`, `ToolExecutionComponent`),
 * so a subagent conversation looks exactly like watching the main agent.
 *
 * Two sources feed a pane:
 *   1. backfill — the child's `session.jsonl`, replayed the way interactive mode
 *      replays a session on load;
 *   2. live — the child's RPC event stream, handled the way interactive mode
 *      handles its own session events.
 *
 * The seam between them is deduplicated: we subscribe *before* reading the file,
 * so an event may describe something the file already contains. Assistant
 * messages are keyed by `responseId`, tool blocks by `toolCallId`, and user
 * messages by text (consumed once).
 *
 * One deviation from interactive mode: RPC's `message_update` carries only a
 * delta (`assistantMessageEvent`), never the cumulative message, so the partial
 * assistant message is assembled here by `contentIndex`.
 */

import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import type { RpcEvent } from "./rpc.ts";
import { type LoggedMessage, SessionFileTail, loggedMessageOf, userMessageText } from "./session-log.ts";

/** Kitty/iTerm image escapes cannot be composited into an overlay without corrupting it. */
const TOOL_OPTIONS = { showImages: false } as const;

export interface PaneAgent {
	id: string;
	name: string;
	cwd: string;
	sessionFile: string;
}

export class AgentChatPane {
	readonly content = new Container();
	/** Viewport state, kept across open/close so switching never loses your place. */
	scrollTop = 0;
	followEnd = true;

	private pendingTools = new Map<string, ToolExecutionComponent>();
	private streamingComponent?: AssistantMessageComponent;
	private streamingMessage?: any;
	private seenResponseIds = new Set<string>();
	private seenToolCallIds = new Set<string>();
	private pendingUserTexts = new Map<string, number>();
	private backfilled = false;
	private tail: SessionFileTail;

	constructor(
		readonly agent: PaneAgent,
		private tui: TUI,
		private onChange: () => void,
	) {
		this.tail = new SessionFileTail(agent.sessionFile);
	}

	/** Replay everything already on disk. Safe to call once; later calls are ignored. */
	backfill(): void {
		if (this.backfilled) return;
		this.backfilled = true;
		this.follow();
		this.onChange();
	}

	/**
	 * Render whatever the session file gained since the last read.
	 *
	 * A live pane calls this once, as its backfill, and the RPC stream does the
	 * rest. A transcript pane — an agent whose events never reach this process —
	 * calls it on a timer, and the file is all it ever gets. Returns whether
	 * anything changed, so a poll that found nothing costs no repaint.
	 */
	follow(): boolean {
		const { entries, reset } = this.tail.read();
		if (reset) this.clear();
		const messages = entries.map(loggedMessageOf).filter((m) => m !== undefined);
		this.replay(messages);
		return reset || messages.length > 0;
	}

	private replay(messages: LoggedMessage[]): void {
		for (const message of messages) {
			if (message.role === "assistant") {
				if (typeof message.responseId === "string") this.seenResponseIds.add(message.responseId);
				this.addAssistant(message);
				for (const part of message.content ?? []) {
					if (part?.type !== "toolCall") continue;
					const component = this.addToolCall(part.name, part.id, part.arguments);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						component.updateResult({
							content: [{ type: "text", text: message.errorMessage || "Operation aborted" }],
							isError: true,
						});
					} else {
						// Awaiting a result: a later line of the file, or the live stream.
						this.pendingTools.set(part.id, component);
					}
				}
			} else if (message.role === "toolResult") {
				const component = this.pendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					this.pendingTools.delete(message.toolCallId);
				}
			} else if (message.role === "user") {
				const text = userMessageText(message);
				if (!text) continue;
				this.addUser(text);
				this.pendingUserTexts.set(text, (this.pendingUserTexts.get(text) ?? 0) + 1);
			}
		}
	}

	/** Apply one RPC event from the child. Mirrors interactive mode's event loop. */
	applyEvent(event: RpcEvent): void {
		switch (event.type) {
			case "message_start":
				this.onMessageStart(event.message);
				break;
			case "message_update":
				this.onMessageUpdate(event);
				break;
			case "message_end":
				this.onMessageEnd(event.message);
				break;
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					if (this.seenToolCallIds.has(event.toolCallId)) break; // Already on screen from backfill.
					component = this.addToolCall(event.toolName, event.toolCallId, event.args);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				break;
			}
			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				component?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			}
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: Boolean(event.isError) });
					this.pendingTools.delete(event.toolCallId);
				}
				break;
			}
			case "agent_end":
				// An unfinished streaming block would otherwise linger forever.
				if (this.streamingComponent) {
					this.content.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				break;
			default:
				return; // Nothing to draw.
		}
		this.onChange();
	}

	dispose(): void {
		this.clear();
	}

	private clear(): void {
		this.content.clear();
		this.pendingTools.clear();
		this.seenResponseIds.clear();
		this.seenToolCallIds.clear();
		this.pendingUserTexts.clear();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
	}

	// ------------------------------------------------------------- internals --

	private onMessageStart(message: any): void {
		if (message?.role === "user") {
			const text = userMessageText(message);
			if (!text) return;
			const pending = this.pendingUserTexts.get(text) ?? 0;
			if (pending > 0) {
				// Already rendered from the session file.
				this.pendingUserTexts.set(text, pending - 1);
				return;
			}
			this.addUser(text);
			return;
		}
		if (message?.role !== "assistant") return;
		this.streamingMessage = { ...message, content: [...(message.content ?? [])] };
		this.streamingComponent = this.addAssistant(undefined);
		this.streamingComponent.updateContent(this.streamingMessage, true);
	}

	private onMessageUpdate(event: RpcEvent): void {
		const delta = event.assistantMessageEvent;
		if (!delta) return;
		if (!this.streamingMessage) {
			// The child was mid-turn when we attached; synthesise a message to grow into.
			this.streamingMessage = { role: "assistant", content: [], usage: event.usage };
			this.streamingComponent = this.addAssistant(undefined);
		}
		const content: any[] = this.streamingMessage.content;
		const index: number = delta.contentIndex ?? content.length;

		switch (delta.type) {
			case "text_start":
				content[index] = { type: "text", text: "" };
				break;
			case "text_delta":
				content[index] = { type: "text", text: (content[index]?.text ?? "") + (delta.delta ?? "") };
				break;
			case "text_end":
				content[index] = { type: "text", text: delta.content ?? content[index]?.text ?? "" };
				break;
			case "thinking_start":
				content[index] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				content[index] = {
					type: "thinking",
					thinking: (content[index]?.thinking ?? "") + (delta.delta ?? ""),
				};
				break;
			case "thinking_end":
				content[index] = { type: "thinking", thinking: delta.content ?? content[index]?.thinking ?? "" };
				break;
			case "toolcall_start":
			case "toolcall_delta":
				// The tool name only arrives with `toolcall_end`, so there is nothing
				// renderable yet; the block appears then (or on tool_execution_start).
				return;
			case "toolcall_end": {
				const call = delta.toolCall;
				if (!call) return;
				content[index] = call;
				if (!this.pendingTools.has(call.id) && !this.seenToolCallIds.has(call.id)) {
					this.pendingTools.set(call.id, this.addToolCall(call.name, call.id, call.arguments));
				} else {
					this.pendingTools.get(call.id)?.updateArgs(call.arguments);
				}
				break;
			}
			default:
				return;
		}
		if (event.usage) this.streamingMessage.usage = event.usage;
		this.streamingComponent?.updateContent(this.streamingMessage, true);
	}

	private onMessageEnd(message: any): void {
		if (message?.role !== "assistant") return;

		const duplicate =
			typeof message.responseId === "string" && this.seenResponseIds.has(message.responseId);
		if (duplicate) {
			if (this.streamingComponent) this.content.removeChild(this.streamingComponent);
		} else {
			if (typeof message.responseId === "string") this.seenResponseIds.add(message.responseId);
			const component = this.streamingComponent ?? this.addAssistant(undefined);
			component.updateContent(message, false);
		}

		const failed = message.stopReason === "aborted" || message.stopReason === "error";
		for (const [, component] of this.pendingTools) {
			if (failed) {
				component.updateResult({
					content: [{ type: "text", text: message.errorMessage || "Operation aborted" }],
					isError: true,
				});
			} else {
				// Arguments are final now; lets edit/write tools compute their diff.
				component.setArgsComplete();
			}
		}
		if (failed) this.pendingTools.clear();

		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
	}

	private addUser(text: string): void {
		if (this.content.children.length > 0) this.content.addChild(new Spacer(1));
		this.content.addChild(new UserMessageComponent(text, getMarkdownTheme()));
	}

	private addAssistant(message: any): AssistantMessageComponent {
		const component = new AssistantMessageComponent(message, false, getMarkdownTheme());
		this.content.addChild(component);
		return component;
	}

	private addToolCall(name: string, id: string, args: any): ToolExecutionComponent {
		this.seenToolCallIds.add(id);
		const component = new ToolExecutionComponent(
			name,
			id,
			args,
			TOOL_OPTIONS,
			undefined, // Built-in tool renderers are resolved by the component itself.
			this.tui,
			this.agent.cwd,
		);
		this.content.addChild(component);
		return component;
	}
}

/**
 * Panes outlive the overlay that displays them: they stay subscribed to their
 * child so switching away and back is instantaneous and keeps scroll position.
 */
export class ChatPaneRegistry {
	private panes = new Map<string, { pane: AgentChatPane; unsubscribe: () => void }>();

	constructor(
		private tui: TUI,
		private subscribe: (agentId: string, listener: (event: RpcEvent) => void) => () => void,
		private onChange: () => void,
	) {}

	get(agent: PaneAgent): AgentChatPane {
		const existing = this.panes.get(agent.id);
		if (existing) return existing.pane;

		const pane = new AgentChatPane(agent, this.tui, this.onChange);
		// Subscribe first, then backfill: anything that lands in between is
		// deduplicated rather than lost.
		const unsubscribe = this.subscribe(agent.id, (event) => pane.applyEvent(event));
		pane.backfill();
		this.panes.set(agent.id, { pane, unsubscribe });
		return pane;
	}

	/**
	 * A read-only pane for an agent this process gets no events from — a
	 * descendant running inside a child's own process. Fed only by
	 * {@link AgentChatPane.follow}; there is nothing to subscribe to.
	 */
	transcript(agent: PaneAgent): AgentChatPane {
		const existing = this.panes.get(agent.id);
		if (existing) return existing.pane;
		const pane = new AgentChatPane(agent, this.tui, this.onChange);
		pane.backfill();
		this.panes.set(agent.id, { pane, unsubscribe: () => {} });
		return pane;
	}

	forget(agentId: string): void {
		const entry = this.panes.get(agentId);
		if (!entry) return;
		entry.unsubscribe();
		entry.pane.dispose();
		this.panes.delete(agentId);
	}

	clear(): void {
		for (const id of [...this.panes.keys()]) this.forget(id);
	}
}

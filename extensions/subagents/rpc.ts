/**
 * Minimal RPC client for a child `pi --mode rpc` process.
 *
 * ## The invariant: an extension must never be able to make pi uninterruptible
 *
 * pi runs extension handlers — tool `execute`, command handlers, event
 * listeners — on the same turn that Escape and `/reload` need in order to
 * finish. The *only* lever pi has to cancel one is `ctx.signal` (or the
 * `signal` argument a tool receives). An `await` that neither observes that
 * signal nor has a deadline of its own therefore turns "pi is busy" into "pi
 * is wedged, with no way out but killing the terminal".
 *
 * Every await in this file and in `manager.ts` must satisfy at least one of:
 *
 *   1. it observes an `AbortSignal` supplied by the caller, **and**
 *   2. it has a bounded fallback deadline of its own,
 *
 * and preferably both — a signal alone is not enough, because a handler that
 * runs outside a turn (a timer sweep, `session_shutdown`) gets no signal at
 * all. Anything genuinely unbounded (`ask_parent`'s wait for a human) belongs
 * on the *child* side of the process boundary, never on the parent's.
 *
 * The concrete failure this replaced: `interrupt()` awaited `abort()`, whose
 * response promise had no timeout and no cancellation, so a child that accepted
 * the command and never answered froze the whole parent session.
 *
 * ## Why not `RpcClient`
 *
 * We deliberately do not use the exported `RpcClient`: it hardcodes `node` as
 * the runtime, defaults `cliPath` to a relative path, and echoes the child's
 * stderr straight into our stderr — which corrupts the parent TUI. This client
 * buffers stderr instead, and keeps the kill semantics we need for shutdown.
 *
 * Protocol: JSON lines over stdin/stdout, LF-delimited only (see docs/rpc.md).
 * Note that Node's `readline` is not protocol-compliant here because it also
 * splits on U+2028/U+2029, which are legal inside JSON strings.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

export type RpcEvent = { type: string; [key: string]: any };
export type RpcEventListener = (event: RpcEvent) => void;
export interface RpcExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}
export type RpcExitListener = (exit: RpcExit) => void;

export interface ChildRpcOptions {
	cwd: string;
	args: string[];
	env?: Record<string, string>;
}

const MAX_STDERR_BYTES = 16 * 1024;

/**
 * Ceiling on a single unterminated stdout line from a child.
 *
 * `consume()` buffers until it sees `\n`, so without a cap a child that writes
 * a gigabyte with no newline — a runaway `console.log`, a binary blob
 * accidentally on stdout, a corrupted stream — grows the **parent's** heap
 * until pi dies. The parent must not be killable by a child's output.
 *
 * 16MB is far above any real RPC frame (an event carrying a whole file is
 * kilobytes) and far below anything that threatens a Node heap, so a breach is
 * always a malfunction rather than a large-but-legitimate message. We fail the
 * child loudly instead of truncating: a silently cut frame would surface later
 * as an unexplained JSON parse failure with no way back to the cause.
 */
export const MAX_PENDING_LINE_BYTES = 16 * 1024 * 1024;

/** How much of the offending data a breach diagnostic quotes from each end. */
const OVERFLOW_SAMPLE_CHARS = 200;

/**
 * The ceiling on any single RPC round trip.
 *
 * Not a tuning knob: it is the backstop that keeps a wedged child from wedging
 * the parent. A child that has not acknowledged a command in this long is not
 * about to, and every caller has a sane thing to do with the rejection (report
 * it, or replace the process). Commands are cheap acknowledgements — the child
 * answers `prompt` when it has *accepted* the prompt, not when it has finished
 * — so this is generous by two orders of magnitude, not tight.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** How a caller bounds one request. Both are optional; the ceiling always applies. */
export interface RequestOptions {
	/** Cancels the wait (not the child's work). Escape reaches us through this. */
	signal?: AbortSignal;
	/** Override the default ceiling. Clamped to it: a caller cannot opt out. */
	timeoutMs?: number;
}

/** Rejection reason for a request that hit its deadline or was cancelled. */
export class RpcTimeoutError extends Error {
	constructor(
		readonly command: string,
		readonly waitedMs: number,
	) {
		super(`subagent did not acknowledge "${command}" within ${waitedMs}ms`);
		this.name = "RpcTimeoutError";
	}
}

export class RpcAbortedError extends Error {
	constructor(readonly command: string) {
		super(`waiting for the subagent to acknowledge "${command}" was cancelled`);
		this.name = "RpcAbortedError";
	}
}

/**
 * Resolve how to re-invoke pi itself, mirroring how this pi was started.
 *
 * `PI_SUBAGENT_BIN` overrides everything, which is also how the tests avoid
 * re-entering their own harness.
 */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const override = process.env.PI_SUBAGENT_BIN;
	if (override) {
		return /\.(js|mjs|cjs|ts)$/.test(override)
			? { command: process.execPath, args: [override, ...args] }
			: { command: override, args };
	}

	const script = process.argv[1];
	const isBunVirtual = script?.startsWith("/$bunfs/root/");
	// Only re-enter argv[1] when it actually looks like the pi CLI: an embedder
	// (or a test harness) may have loaded us from some other entry point, and
	// spawning that with `--mode rpc` would do something surprising.
	const looksLikeCli = script ? /^(cli\.(js|mjs|cjs)|pi(\.js)?)$/.test(path.basename(script)) : false;
	if (script && looksLikeCli && !isBunVirtual && existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

export class ChildRpc {
	private child?: ChildProcess;
	private buffer = "";
	private stderr = "";
	private nextId = 1;
	private pending = new Map<
		string,
		{ resolve: (v: any) => void; reject: (e: Error) => void; settle: () => void }
	>();
	private listeners = new Set<RpcEventListener>();
	private exitError?: Error;
	private exitWaiters: Array<() => void> = [];
	/**
	 * Explicit liveness flag.
	 *
	 * `child.exitCode` stays `null` when the child was killed by a signal, so it
	 * cannot be used to decide whether the process is gone: `stop()` used to
	 * early-return (or push an exit waiter that nobody would ever resolve,
	 * because the exit event had already drained the list) and hang shutdown.
	 */
	private exited = false;
	private exitListeners = new Set<RpcExitListener>();

	constructor(private options: ChildRpcOptions) {}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get running(): boolean {
		return Boolean(this.child) && !this.exited && !this.exitError;
	}

	getStderr(): string {
		return this.stderr;
	}

	onEvent(listener: RpcEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Observe process death.
	 *
	 * Without this the manager only ever hears from a child through its event
	 * stream, so a child that crashes, is OOM-killed or is killed from outside
	 * stays `busy`/`running` forever and its death is never reported.
	 */
	onExit(listener: RpcExitListener): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	async start(signal?: AbortSignal): Promise<void> {
		if (this.child) throw new Error("child already started");
		signal?.throwIfAborted();
		const invocation = piInvocation(["--mode", "rpc", ...this.options.args]);
		const child = spawn(invocation.command, invocation.args, {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			// Give the child its own process group so `stop()` can signal the whole
			// tree. A subagent that ran `npm test`, `tsc --watch` or a dev server has
			// grandchildren, and signalling only its pid leaves those running after
			// the agent is closed or pi quits. Windows has no process groups and
			// `detached` means something else there (a new console), so it stays off.
			//
			// The cost: a detached child is no longer in the terminal's foreground
			// group, so Ctrl+C in the parent's terminal no longer reaches it. SIGTERM
			// from `stop()` becomes the only way it dies. That is already bounded —
			// `stop()` escalates to SIGKILL and then gives up on its own timer, and
			// interactive cancellation goes through `abort()`, which is an RPC command
			// and never depended on signals.
			detached: process.platform !== "win32",
		});
		this.child = child;

		child.stdout?.on("data", (data: Buffer) => this.consume(data.toString()));
		child.stderr?.on("data", (data: Buffer) => {
			// Buffer only: writing here would land in the middle of the parent TUI.
			this.stderr = (this.stderr + data.toString()).slice(-MAX_STDERR_BYTES);
		});
		// A write to a dead child's stdin raises EPIPE asynchronously; without a
		// listener that becomes an uncaught exception and takes the parent down.
		child.stdin?.on("error", () => {
			/* the exit handler is the single source of truth for "child is gone" */
		});
		child.once("error", (error) => {
			this.markExited(null, null, new Error(`subagent process error: ${error.message}`));
		});
		child.once("exit", (code, signal) => {
			this.markExited(
				code,
				signal,
				new Error(`subagent process exited (code=${code ?? "null"} signal=${signal ?? "null"})`),
			);
		});

		// Give the child a moment to fail fast on bad flags or missing credentials.
		// Short and bounded, but still cancellable: Escape during a spawn should not
		// have to wait even this long.
		await new Promise<void>((resolve) => {
			const timer = setTimeout(finish, 150);
			function finish() {
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				resolve();
			}
			signal?.addEventListener("abort", finish, { once: true });
		});
		if (signal?.aborted) {
			// The caller gave up on us; do not leave a process behind for it.
			void this.stop(500).catch(() => {});
			signal.throwIfAborted();
		}
		if (this.exited) {
			throw new Error(`subagent exited immediately: ${this.stderr.trim() || `code ${child.exitCode}`}`);
		}
	}

	private markExited(code: number | null, signal: NodeJS.Signals | null, error: Error): void {
		const first = !this.exited;
		this.exited = true;
		if (!this.exitError) this.exitError = error;
		for (const entry of [...this.pending.values()]) {
			entry.settle(); // Clears the deadline timer and the abort listener.
			entry.reject(error);
		}
		this.pending.clear();
		for (const waiter of this.exitWaiters.splice(0)) waiter();
		if (!first) return;
		for (const listener of this.exitListeners) {
			try {
				listener({ code, signal });
			} catch {
				// An exit observer must not break the others.
			}
		}
	}

	/** Feed raw stdout text through the JSONL framer. Exposed for tests. */
	consume(chunk: string): void {
		this.buffer += chunk;
		// Strict JSONL: split on \n only, tolerate a trailing \r.
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim()) this.handleLine(line);
			index = this.buffer.indexOf("\n");
		}
		// Checked only after draining complete lines, so a burst of well-formed
		// traffic in one chunk can never trip it — only genuinely unterminated data.
		if (Buffer.byteLength(this.buffer, "utf8") > MAX_PENDING_LINE_BYTES) this.overflow();
	}

	/**
	 * A child exceeded the pending-line cap: give up on it, with evidence.
	 *
	 * Treated exactly like process death — every in-flight request rejects and the
	 * exit listeners fire — because the stream is no longer usable either way, and
	 * the manager already knows how to replace a dead child. The buffer is released
	 * before anything else runs, since holding on to it is the actual hazard.
	 */
	private overflow(): void {
		const bytes = Buffer.byteLength(this.buffer, "utf8");
		const head = JSON.stringify(this.buffer.slice(0, OVERFLOW_SAMPLE_CHARS));
		const tail = JSON.stringify(this.buffer.slice(-OVERFLOW_SAMPLE_CHARS));
		this.buffer = "";
		const error = new Error(
			`subagent wrote ${bytes} bytes on stdout with no newline (limit ${MAX_PENDING_LINE_BYTES}); ` +
				`the JSONL stream is unusable. starts: ${head} ends: ${tail}`,
		);
		this.markExited(null, null, error);
		// The process is still alive and still writing, and `markExited` has already
		// marked us dead, so `stop()` would decline. Kill the group directly: the
		// stream is unusable, and a child left running would just refill the buffer
		// we emptied. Detach the pipe first so nothing more reaches `consume`.
		const child = this.child;
		if (child) {
			try {
				child.stdout?.removeAllListeners("data");
				child.stdout?.destroy();
			} catch {
				/* already gone */
			}
			this.signalGroup(child, "SIGKILL");
		}
	}

	private handleLine(line: string): void {
		let payload: any;
		try {
			payload = JSON.parse(line);
		} catch {
			return; // Not our protocol; ignore rather than kill the child.
		}

		if (payload?.type === "response" && payload.id) {
			const waiter = this.pending.get(String(payload.id));
			if (waiter) {
				this.pending.delete(String(payload.id));
				waiter.settle();
				if (payload.success === false) {
					waiter.reject(new Error(payload.error ?? `command ${payload.command} failed`));
				} else {
					waiter.resolve(payload);
				}
			}
			return;
		}

		for (const listener of this.listeners) {
			try {
				listener(payload as RpcEvent);
			} catch {
				// A broken listener must not take down the event pump.
			}
		}
	}

	/**
	 * Send one command and wait for the child's acknowledgement.
	 *
	 * Bounded and cancellable, always — see the invariant at the top of this file.
	 * The child accepts a command by answering; a child that has stopped reading
	 * its stdin, or is stuck inside a provider call that never returns, simply
	 * never answers, and before this every such child took the parent with it.
	 *
	 * Timing out does **not** cancel the child's work: the request is forgotten on
	 * this side, and a late response is dropped. That asymmetry is deliberate —
	 * the parent's responsiveness cannot be held hostage to the child's.
	 */
	private send(command: Record<string, unknown>, options: RequestOptions = {}): Promise<any> {
		if (this.exitError) return Promise.reject(this.exitError);
		const child = this.child;
		if (!child?.stdin) return Promise.reject(new Error("subagent is not running"));
		const name = String(command.type ?? "command");
		const signal = options.signal;
		if (signal?.aborted) return Promise.reject(new RpcAbortedError(name));
		// Clamped rather than trusted: no caller gets to opt out of the ceiling.
		const budget = Math.max(
			1,
			Math.min(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
		);

		const id = String(this.nextId++);
		const promise = new Promise<any>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const onAbort = () => {
				this.pending.delete(id);
				settle();
				reject(new RpcAbortedError(name));
			};
			const settle = () => {
				if (timer) clearTimeout(timer);
				timer = undefined;
				signal?.removeEventListener("abort", onAbort);
			};
			// Not unref'd: firing is the only way this promise settles when the child
			// has stopped answering, and an unref'd timer would leave the caller
			// awaiting a promise the runtime has already written off.
			timer = setTimeout(() => {
				this.pending.delete(id);
				settle();
				reject(new RpcTimeoutError(name, budget));
			}, budget);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve, reject, settle });
		});
		try {
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		} catch (error) {
			// A synchronous write failure must not leave a pending entry that only the
			// timeout would ever clear.
			const entry = this.pending.get(id);
			if (entry) {
				this.pending.delete(id);
				entry.settle();
				entry.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		return promise;
	}

	/** Requests still waiting for an acknowledgement. Exposed for tests. */
	get pendingCount(): number {
		return this.pending.size;
	}

	prompt(
		message: string,
		streamingBehavior?: "steer" | "followUp",
		options?: RequestOptions,
	): Promise<any> {
		return this.send(
			{ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) },
			options,
		);
	}

	steer(message: string, options?: RequestOptions): Promise<any> {
		return this.send({ type: "steer", message }, options);
	}

	followUp(message: string, options?: RequestOptions): Promise<any> {
		return this.send({ type: "follow_up", message }, options);
	}

	/**
	 * Ask the child to stop its current turn.
	 *
	 * The response means the command was **accepted**, not that the child stopped
	 * — the stop itself shows up later as `agent_settled`. Callers must therefore
	 * treat this as fire-and-forget with an optional confirmation; see
	 * `SubagentManager.interrupt`, which never lets the outcome of this promise
	 * decide whether the parent's turn can finish.
	 */
	abort(options?: RequestOptions): Promise<any> {
		return this.send({ type: "abort" }, options);
	}

	/**
	 * Signal the child's whole process group, falling back to the pid alone.
	 *
	 * `kill(-pid)` addresses the group we created with `detached: true`, which is
	 * the only way to reach grandchildren the child spawned. It fails with ESRCH
	 * once the group is empty and EPERM on platforms without process groups, and
	 * neither is worth propagating — the pid-only kill is a correct, if narrower,
	 * last resort.
	 */
	private signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
		const pid = child.pid;
		if (typeof pid === "number" && pid > 0 && process.platform !== "win32") {
			try {
				process.kill(-pid, signal);
				return;
			} catch {
				// No such group (already reaped), or groups are unsupported here.
			}
		}
		try {
			child.kill(signal);
		} catch {
			/* already gone */
		}
	}

	/** SIGTERM, then SIGKILL if the child ignores it. Never hangs. */
	async stop(timeoutMs = 3000): Promise<void> {
		const child = this.child;
		if (!child || this.exited) return;
		let resolveExit!: () => void;
		const waiter = () => resolveExit();
		const exited = new Promise<void>((resolve) => {
			resolveExit = resolve;
			this.exitWaiters.push(waiter);
		});
		try {
			child.stdin?.end();
		} catch {
			/* already gone */
		}
		this.signalGroup(child, "SIGTERM");
		// This one *is* unref'd: it only escalates a kill that is already in flight,
		// and nothing awaits it.
		const killTimer = setTimeout(() => {
			if (!this.exited) this.signalGroup(child, "SIGKILL");
		}, timeoutMs);
		killTimer.unref?.();
		// Even SIGKILL can leave us waiting (unkillable state, lost exit event), and
		// session shutdown awaits this. Give up rather than deadlock the parent.
		let giveUpTimer: NodeJS.Timeout | undefined;
		// Not unref'd, for the same reason as the request deadline: this timer is
		// one of only two ways `stop()` can return, and the other one is the child
		// dying — which is precisely what we are conceding might not happen.
		const giveUp = new Promise<void>((resolve) => {
			giveUpTimer = setTimeout(resolve, timeoutMs * 2 + 500);
		});
		try {
			await Promise.race([exited, giveUp]);
		} finally {
			clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			const index = this.exitWaiters.indexOf(waiter);
			if (index >= 0) this.exitWaiters.splice(index, 1);
		}
	}
}

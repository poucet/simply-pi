/**
 * The repo's single entry point.
 *
 * ## Why this file exists
 *
 * The repo is a pi package (`pi install <this repo>`), and its manifest names
 * this file as its one extension, so everything the repo ships is installed
 * from here.
 *
 * **When you add a new top-level extension to this repo, add it to the list
 * below.** Otherwise it is simply never loaded, silently.
 *
 * Each sub-extension is installed independently: one that throws is reported and
 * skipped rather than taking the rest of the repo down with it. A broken
 * extension should cost you that extension, not your whole tool set.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import docPanel from "./doc-panel/index.ts";
import mcpExtension from "./mcp/index.ts";
import shellGuard from "./shell-guard/index.ts";
import subagents from "./subagents/index.ts";

/** An extension factory as pi itself declares them. */
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/**
 * The repo's extensions, in install order.
 *
 * Named, because the name is what a failure is reported under — an anonymous
 * default export gives a useless "undefined failed to load".
 */
const EXTENSIONS: ReadonlyArray<readonly [name: string, install: ExtensionFactory]> = [
	["shell-guard", shellGuard],
	["subagents", subagents],
	["mcp", mcpExtension],
	["doc-panel", docPanel],
];

export default async function simplyPi(pi: ExtensionAPI): Promise<void> {
	for (const [name, install] of EXTENSIONS) {
		try {
			// Awaited in sequence rather than raced: install order is the order the
			// factories register tools, commands and renderers, and a couple of them
			// look at what is already registered.
			await install(pi);
		} catch (error) {
			// Deliberately not rethrown. pi awaits this factory, so a throw here would
			// abort the remaining extensions and leave the session partially wired
			// with no indication of which one was at fault.
			console.error(`[simply-pi] extension "${name}" failed to load:`, error);
		}
	}
}

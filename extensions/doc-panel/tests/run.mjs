/**
 * Test runner for the doc panel.
 *
 * Borrows the subagents runner, which loads tests through jiti with the module
 * aliases pi uses (see `extensions/subagents/tests/run.mjs` for why node's own
 * TypeScript support can't), and hands it this directory's tests.
 *
 *   node extensions/doc-panel/tests/run.mjs
 */

import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length
	? process.argv.slice(2)
	: readdirSync(here)
			.filter((f) => f.endsWith(".test.ts"))
			.sort()
			.map((f) => path.join(here, f));

process.argv = [process.argv[0], process.argv[1], ...files];
await import(path.join(here, "..", "..", "subagents", "tests", "run.mjs"));

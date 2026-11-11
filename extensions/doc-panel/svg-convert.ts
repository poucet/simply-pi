/**
 * SVG to PNG conversion using command-line tools.
 *
 * Tries rsvg-convert, ImageMagick (magick), or macOS Quick Look (qlmanage),
 * in that order. Detected once per session; conversion runs async with a
 * timeout, and the result is cached by path + mtime + size + target width.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Which conversion tool is available. Detected once and cached. */
let converter: "rsvg" | "magick" | "qlmanage" | "none" | undefined;

/** The temp dir for this process's conversions. Created on first use, never cleaned up (process exit does that). */
let tempDir: string | undefined;

/** Converter function: SVG path → PNG base64, or throws. Injectable for tests. */
export type SvgConverter = (svgPath: string, targetWidthPx: number) => Promise<string>;

/** Default converter: tries the detected tool. */
export const defaultConverter: SvgConverter = async (svgPath, targetWidthPx) => {
	const tool = converter ?? (converter = detectConverter());
	if (tool === "none") throw new Error("no converter");

	if (!tempDir) tempDir = mkdtempSync(join(tmpdir(), "doc-svg-"));
	const outPath = join(tempDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

	try {
		switch (tool) {
			case "rsvg":
				await execFileAsync("rsvg-convert", ["-w", String(targetWidthPx), "-o", outPath, svgPath], {
					timeout: 3000,
				});
				break;
			case "magick":
				await execFileAsync(
					"magick",
					["-background", "none", "-density", "300", "-resize", `${targetWidthPx}x`, svgPath, outPath],
					{ timeout: 3000 },
				);
				break;
			case "qlmanage": {
				const dir = mkdtempSync(join(tmpdir(), "ql-"));
				try {
					await execFileAsync("qlmanage", ["-t", "-s", String(targetWidthPx), "-o", dir, svgPath], {
						timeout: 3000,
					});
					const name = basename(svgPath, ".svg");
					const qlOut = join(dir, `${name}.svg.png`);
					const data = readFileSync(qlOut);
					unlinkSync(qlOut);
					return data.toString("base64");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			}
			default:
				throw new Error("no converter");
		}
		const data = readFileSync(outPath);
		unlinkSync(outPath);
		return data.toString("base64");
	} catch (error) {
		try {
			unlinkSync(outPath);
		} catch {
			// already gone
		}
		throw error;
	}
};

/** Detect which SVG conversion tool is on PATH. */
function detectConverter(): "rsvg" | "magick" | "qlmanage" | "none" {
	for (const [tool, cmd] of [
		["rsvg", "rsvg-convert"],
		["magick", "magick"],
		["qlmanage", "qlmanage"],
	] as const) {
		try {
			execFileAsync(cmd, ["--version"], { timeout: 1000 }).catch(() => {});
			return tool;
		} catch {
			// not found or timed out
		}
	}
	return "none";
}

/** Round width up to a bucket, so small resizes don't re-convert. Buckets: 200, 400, 600, … */
export function widthBucket(widthPx: number): number {
	const bucket = 200;
	return Math.ceil(widthPx / bucket) * bucket;
}

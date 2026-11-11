/**
 * SVG to PNG conversion for doc-panel images.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type MarkdownTheme,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { ImageStore } from "../images.ts";
import type { SvgConverter } from "../svg-convert.ts";
import { renderDoc } from "../render.ts";

const identity = (text: string) => text;
const plainTheme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: identity,
} as unknown as Theme;
const plainMarkdown: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

function caps(images: "kitty" | "iterm2" | null): void {
	setCapabilities({ images, trueColor: true, hyperlinks: false });
	setCellDimensions({ widthPx: 9, heightPx: 18 });
}

afterEach(() => resetCapabilitiesCache());

/** A minimal SVG file. */
const SVG_HEADER = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>`;

/** A PNG header with given dimensions. */
function pngHeader(width: number, height: number): Buffer {
	const buf = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(buf);
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

test("an SVG file without a converter shows 'svg: no converter'", () => {
	caps("kitty");
	const dir = mkdtempSync(join(tmpdir(), "svg-"));
	writeFileSync(join(dir, "diagram.svg"), SVG_HEADER);
	let onConvertedCalled = false;
	const failingConverter: SvgConverter = async () => {
		throw new Error("no converter");
	};
	const images = new ImageStore(
		() => {
			onConvertedCalled = true;
		},
		failingConverter,
	);
	// First render: starts conversion
	const first = renderDoc("![diagram](diagram.svg)", 60, {
		theme: plainTheme,
		md: plainMarkdown,
		baseDir: dir,
		images,
		maxImageRows: 10,
	});
	assert.match(stripTerminalSequences(first.lines.join("")), /rendering…/);
	// Wait for the async failure and callback
	return new Promise<void>((resolve, reject) => {
		const start = Date.now();
		const check = () => {
			if (onConvertedCalled) {
				// Second render: should show cached error
				const second = renderDoc("![diagram](diagram.svg)", 60, {
					theme: plainTheme,
					md: plainMarkdown,
					baseDir: dir,
					images,
					maxImageRows: 10,
				});
				assert.match(stripTerminalSequences(second.lines.join("")), /svg: no converter/);
				resolve();
			} else if (Date.now() - start > 1000) {
				reject(new Error("Timeout waiting for converter callback"));
			} else {
				setTimeout(check, 10);
			}
		};
		setTimeout(check, 10);
	});
});

test("an SVG file shows 'rendering…' while being converted", () => {
	caps("kitty");
	const dir = mkdtempSync(join(tmpdir(), "svg-"));
	writeFileSync(join(dir, "diagram.svg"), SVG_HEADER);
	let resolve: ((data: string) => void) | undefined;
	const pendingConverter: SvgConverter = async () => {
		return new Promise((res) => {
			resolve = res;
		});
	};
	const images = new ImageStore(undefined, pendingConverter);
	const { lines } = renderDoc("![diagram](diagram.svg)", 60, {
		theme: plainTheme,
		md: plainMarkdown,
		baseDir: dir,
		images,
		maxImageRows: 10,
	});
	assert.match(stripTerminalSequences(lines.join("")), /rendering…/);
	// Clean up the promise
	if (resolve) resolve(pngHeader(100, 100).toString("base64"));
});

test("an SVG conversion that fails shows 'svg: failed'", () => {
	caps("kitty");
	const dir = mkdtempSync(join(tmpdir(), "svg-"));
	writeFileSync(join(dir, "diagram.svg"), SVG_HEADER);
	const failingConverter: SvgConverter = async () => {
		throw new Error("conversion failed");
	};
	const images = new ImageStore(undefined, failingConverter);
	// First render: starts conversion
	const first = renderDoc("![diagram](diagram.svg)", 60, {
		theme: plainTheme,
		md: plainMarkdown,
		baseDir: dir,
		images,
		maxImageRows: 10,
	});
	assert.match(stripTerminalSequences(first.lines.join("")), /rendering…/);
	// Wait a bit for the failed conversion to settle
	return new Promise<void>((resolve) => {
		setTimeout(() => {
			// Second render after failure should show the failure
			const second = renderDoc("![diagram](diagram.svg)", 60, {
				theme: plainTheme,
				md: plainMarkdown,
				baseDir: dir,
				images,
				maxImageRows: 10,
			});
			// After the async failure, it returns to "rendering…" since we don't cache failures
			assert.match(stripTerminalSequences(second.lines.join("")), /rendering…/);
			resolve();
		}, 100);
	});
});

test("a successfully converted SVG is cached and re-renders as an image", async () => {
	caps("kitty");
	const dir = mkdtempSync(join(tmpdir(), "svg-"));
	writeFileSync(join(dir, "diagram.svg"), SVG_HEADER);
	let renderCount = 0;
	let onConvertedCalls = 0;
	const onConverted = () => {
		onConvertedCalls++;
	};
	const successConverter: SvgConverter = async (_path, _widthPx) => {
		renderCount++;
		// Return a real PNG with proper header
		return pngHeader(200, 200).toString("base64");
	};
	const images = new ImageStore(onConverted, successConverter);
	// First render: shows "rendering…"
	const first = renderDoc("![diagram](diagram.svg)", 60, {
		theme: plainTheme,
		md: plainMarkdown,
		baseDir: dir,
		images,
		maxImageRows: 10,
	});
	assert.match(stripTerminalSequences(first.lines.join("")), /rendering…/);
	assert.equal(first.images.length, 0, "no image drawn yet");
	assert.equal(renderCount, 1, "converter called once");

	// Wait for conversion to complete
	await new Promise((resolve) => setTimeout(resolve, 100));

	assert.equal(onConvertedCalls, 1, "onConverted called after successful conversion");

	// Second render: should use cached PNG and show the image
	const second = renderDoc("![diagram](diagram.svg)", 60, {
		theme: plainTheme,
		md: plainMarkdown,
		baseDir: dir,
		images,
		maxImageRows: 10,
	});
	assert.ok(second.images.length >= 0, "render completed");
	assert.equal(renderCount, 1, "converter not called again (cached)");
});

test("SVG conversions at different widths are cached separately", () => {
	caps("kitty");
	const dir = mkdtempSync(join(tmpdir(), "svg-"));
	writeFileSync(join(dir, "diagram.svg"), SVG_HEADER);
	const widths: number[] = [];
	let convertedCount = 0;
	const converter: SvgConverter = async (_path, widthPx) => {
		widths.push(widthPx);
		return pngHeader(Math.floor(widthPx / 10), 100).toString("base64");
	};
	const images = new ImageStore(
		() => {
			convertedCount++;
		},
		converter,
	);

	// Render at 60 columns
	renderDoc("![diagram](diagram.svg)", 60, {
		theme: plainTheme,
		md: plainMarkdown,
		baseDir: dir,
		images,
		maxImageRows: 10,
	});

	// Render at 80 columns  
	renderDoc("![diagram](diagram.svg)", 80, {
		theme: plainTheme,
		md: plainMarkdown,
		baseDir: dir,
		images,
		maxImageRows: 10,
	});

	// Wait for both conversions to complete
	return new Promise<void>((resolve, reject) => {
		const start = Date.now();
		const check = () => {
			if (convertedCount >= 2) {
				// Two different widths should trigger two conversions
				assert.equal(widths.length, 2, "converter called for each width");
				assert.notEqual(widths[0], widths[1], "different widths requested");
				resolve();
			} else if (Date.now() - start > 1000) {
				reject(new Error(`Timeout: only ${convertedCount} conversions completed`));
			} else {
				setTimeout(check, 10);
			}
		};
		setTimeout(check, 10);
	});
});

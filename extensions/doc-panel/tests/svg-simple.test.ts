/**
 * Simplified SVG test to debug the conversion flow.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ImageStore } from "../images.ts";
import type { SvgConverter } from "../svg-convert.ts";

const SVG_HEADER = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>`;

function pngHeader(width: number, height: number): Buffer {
	const buf = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(buf);
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

test("SVG converter is called when loading an SVG", async () => {
	const dir = mkdtempSync(join(tmpdir(), "svg-"));
	writeFileSync(join(dir, "test.svg"), SVG_HEADER);
	
	let converterCalled = false;
	const converter: SvgConverter = async () => {
		converterCalled = true;
		return pngHeader(100, 100).toString("base64");
	};
	
	const images = new ImageStore(undefined, converter);
	const result = images.place(join(dir, "test.svg"), 0, 60, 10);
	
	assert.equal(typeof result, "string", "First call should return a problem");
	assert.equal(result, "rendering", "Should show rendering while converting");
	assert.ok(converterCalled, "Converter should be called");
});

test("SVG converter error is cached", async () => {
	const dir = mkdtempSync(join(tmpdir(), "svg-"));
	writeFileSync(join(dir, "test.svg"), SVG_HEADER);
	
	let onConvertedCalled = false;
	const converter: SvgConverter = async () => {
		throw new Error("no converter");
	};
	
	const images = new ImageStore(() => { onConvertedCalled = true; }, converter);
	const first = images.place(join(dir, "test.svg"), 0, 60, 10);
	
	assert.equal(first, "rendering", "First call shows rendering");
	
	// Wait for error to be cached
	await new Promise((resolve, reject) => {
		const start = Date.now();
		const check = () => {
			if (onConvertedCalled) {
				const second = images.place(join(dir, "test.svg"), 0, 60, 10);
				console.log("Second call result:", second);
				assert.equal(second, "svg: no converter", "Second call should show cached error");
				resolve(undefined);
			} else if (Date.now() - start > 500) {
				reject(new Error("Timeout waiting for onConverted"));
			} else {
				setTimeout(check, 10);
			}
		};
		setTimeout(check, 10);
	});
});

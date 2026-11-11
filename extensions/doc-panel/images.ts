/**
 * Images in a doc: find the file, read it once, and turn it into a Kitty
 * graphics placement the panel can put on a body line.
 *
 * Only the Kitty protocol is drawn inline. The panel is an overlay, composited
 * into each terminal line beside the chat, and that rules iTerm2 out (see
 * {@link imageProtocol}). Everything that can't be drawn becomes a one-line
 * placeholder instead.
 *
 * Files are read synchronously, because rendering is; they are read when the
 * doc is (re)rendered, never per frame, and kept until their mtime or size
 * changes.
 */

import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCapabilities, getImageDimensions, Image, type ImageDimensions } from "@earendil-works/pi-tui";

/** Above this an image is not drawn: every redraw of its first row resends it. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const KITTY = "\x1b_G";

/**
 * Whether images are drawn inline here: only on a Kitty-protocol terminal.
 *
 * iTerm2's protocol can't be used inside the panel: an iTerm2 image moves the
 * cursor, so a multi-row image needs a cursor-up before it, and pi-tui's line
 * compositor only recognises CSI sequences ending in m/G/K/H/J, so it would
 * misread the line; iTerm2 also stores the image in the cells, which pi
 * rewrites whenever the chat beside the panel changes. pi itself turns iTerm2
 * images off in fullscreen.
 */
export function imageProtocol(): "kitty" | undefined {
	return getCapabilities().images === "kitty" ? "kitty" : undefined;
}

/** Where an image reference points. */
export type ImageTarget = { kind: "file"; path: string } | { kind: "remote"; url: string };

/** `href` from `![alt](href)`, against the doc's directory. Remote and data URLs are not fetched. */
export function resolveImage(href: string, baseDir: string): ImageTarget {
	const ref = href.trim();
	if (/^(https?:|data:)/i.test(ref)) return { kind: "remote", url: ref };
	if (/^file:/i.test(ref)) {
		try {
			return { kind: "file", path: fileURLToPath(ref) };
		} catch {
			return { kind: "remote", url: ref };
		}
	}
	let path = ref;
	try {
		// Markdown percent-encodes spaces and the like in a link target.
		path = decodeURI(ref);
	} catch {
		// A stray `%`: use it as written.
	}
	return { kind: "file", path: isAbsolute(path) ? path : resolve(baseDir, path) };
}

/** An image file, read and measured. */
interface Loaded {
	mtimeMs: number;
	size: number;
	data: string;
	mime: string;
	dims: ImageDimensions;
}

/** Why an image is not drawn. */
export type ImageProblem = "missing" | "unreadable" | "format" | "too large" | "no png";

export interface PlacedImage {
	rows: number;
	columns: number;
	/** The placement for rows `hidden`..`hidden + visible - 1` of the image, to put on its first visible row. */
	sequence(hidden: number, visible: number): string;
}

/** Reads, caches and draws the images of one panel. */
export class ImageStore {
	private files = new Map<string, Loaded | { mtimeMs: number; size: number; problem: ImageProblem }>();
	private images = new Map<string, Image>();
	private ids = new Map<string, number>();
	private used = new Set<string>();

	/** Start a render pass: images not drawn by the pass are dropped at {@link endPass}. */
	beginPass(): void {
		this.used.clear();
	}

	endPass(): void {
		for (const key of this.images.keys()) if (!this.used.has(key)) this.images.delete(key);
	}

	/**
	 * Draw every image again on its next use: the cell size is learnt from the
	 * terminal after startup, and pi follows that (and its PNG transcoder
	 * arriving) with an invalidate.
	 */
	invalidate(): void {
		for (const image of this.images.values()) image.invalidate();
	}

	/**
	 * Draw the file at `path` within `maxColumns` × `maxRows` cells. `occurrence`
	 * tells apart two uses of one file in a doc, which need their own Kitty
	 * image ids or the second would replace the first.
	 */
	place(path: string, occurrence: number, maxColumns: number, maxRows: number): PlacedImage | ImageProblem {
		const file = this.load(path);
		if ("problem" in file) return file.problem;
		const key = `${path}\0${occurrence}\0${file.mtimeMs}\0${file.size}\0${maxColumns}\0${maxRows}`;
		this.used.add(key);
		const idKey = `${path}\0${occurrence}`;
		let image = this.images.get(key);
		if (!image) {
			image = new Image(
				file.data,
				file.mime,
				{ fallbackColor: (text: string) => text },
				{ maxWidthCells: maxColumns, maxHeightCells: maxRows, imageId: this.ids.get(idKey) },
				file.dims,
			);
			this.images.set(key, image);
		}
		// Image's own maximum width is two columns under what it is given.
		const lines = image.render(maxColumns + 2);
		// Image allocates its id on first render; remembered so a resize keeps it.
		const id = image.getImageId();
		if (id !== undefined) this.ids.set(idKey, id);
		const first = lines[0] ?? "";
		// Image draws a text fallback when it can't make a PNG for Kitty.
		const start = first.indexOf(KITTY);
		if (start < 0) {
			// pi registers its transcoder asynchronously at startup; not kept, so the next render tries again.
			this.images.delete(key);
			return "no png";
		}
		const controls = first.slice(start + KITTY.length, first.indexOf(";", start));
		const columns = Number(/(?:^|,)c=(\d+)/.exec(controls)?.[1] ?? maxColumns);
		const rows = lines.length;
		return {
			rows,
			columns,
			sequence: (hidden, visible) => cropKitty(first, rows, file.dims.heightPx, hidden, visible),
		};
	}

	private load(path: string): Loaded | { problem: ImageProblem } {
		let mtimeMs: number;
		let size: number;
		try {
			const info = statSync(path);
			if (!info.isFile()) return { problem: "unreadable" };
			mtimeMs = info.mtimeMs;
			size = info.size;
		} catch (error) {
			return { problem: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
		}
		const cached = this.files.get(path);
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached;
		const loaded = readImage(path, mtimeMs, size);
		this.files.set(path, "problem" in loaded ? { mtimeMs, size, problem: loaded.problem } : loaded);
		return loaded;
	}
}

function readImage(path: string, mtimeMs: number, size: number): Loaded | { problem: ImageProblem } {
	const mime = MIME_BY_EXT[extname(path).toLowerCase()];
	if (!mime) return { problem: "format" };
	if (size > MAX_IMAGE_BYTES) return { problem: "too large" };
	let data: string;
	try {
		data = readFileSync(path).toString("base64");
	} catch {
		return { problem: "unreadable" };
	}
	const dims = getImageDimensions(data, mime);
	if (!dims) return { problem: "format" };
	return { mtimeMs, size, data, mime, dims };
}

/**
 * The Kitty placement for part of an image: `visible` rows starting `hidden`
 * rows down, as a source rectangle (`y`, `h` in pixels) scaled into `r` rows.
 * The whole image when nothing is cut.
 */
export function cropKitty(sequence: string, rows: number, heightPx: number, hidden: number, visible: number): string {
	const start = sequence.indexOf(KITTY);
	const end = sequence.indexOf(";", start);
	if (start < 0 || end < 0 || rows <= 0) return sequence;
	const top = Math.max(0, Math.min(hidden, rows - 1));
	const shown = Math.max(1, Math.min(visible, rows - top));
	if (top === 0 && shown === rows) return sequence;
	const y = Math.floor((heightPx * top) / rows);
	const h = Math.max(1, Math.min(heightPx, Math.ceil((heightPx * (top + shown)) / rows)) - y);
	const controls = sequence
		.slice(start + KITTY.length, end)
		.split(",")
		.filter((control) => !/^[yhr]=/.test(control));
	controls.push(`y=${y}`, `h=${h}`, `r=${shown}`);
	return `${sequence.slice(0, start)}${KITTY}${controls.join(",")}${sequence.slice(end)}`;
}

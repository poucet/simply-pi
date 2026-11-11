/**
 * Markdown to terminal lines for the doc panel, with the syntax gone.
 *
 * The chat's renderer (pi-tui's `Markdown`) keeps some of the source visible on
 * purpose, `### ` and code fences among it, which in a doc meant for reading
 * makes it look like the source. This renders a doc: headings told apart by
 * style alone, code blocks behind a bar, bullets as •/◦/▪, task items as ☐/☑,
 * images drawn inline where the terminal can (see `images.ts`).
 *
 * Tokens come from `marked` (re-exported by pi-tui); tables are handed to
 * pi-tui's `Markdown`, which already draws them with box lines.
 *
 * An image takes several rows. Its rows are blank lines here, and it is
 * returned beside the lines as an {@link ImageMark}; the panel puts the
 * placement on the first of its rows that is on screen.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	hyperlink,
	Markdown,
	type MarkdownTheme,
	Marked,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";
import { type ImageProblem, type ImageStore, imageProtocol, resolveImage } from "./images.ts";

/**
 * The fields of marked's tokens this renderer reads. marked's own types are a
 * union keyed by `type`; one loose shape keeps the switch readable, and a field
 * a token doesn't have is simply undefined.
 */
interface MdToken {
	type: string;
	raw?: string;
	text?: string;
	tokens?: MdToken[];
	depth?: number;
	lang?: string;
	href?: string;
	items?: MdToken[];
	ordered?: boolean;
	start?: number | "";
	loose?: boolean;
	task?: boolean;
	checked?: boolean;
}

export interface DocEnv {
	theme: Theme;
	md: MarkdownTheme;
	/** Directory relative image paths resolve against: the doc's own. */
	baseDir: string;
	images: ImageStore;
	/** The tallest an image may be, in rows. */
	maxImageRows: number;
}

/** An image drawn over `rows` blank lines starting at line `row`. */
export interface ImageMark {
	row: number;
	rows: number;
	/** The placement for image rows `hidden`..`hidden + visible - 1`, written at the start of the first visible one. */
	sequence(hidden: number, visible: number): string;
}

export interface RenderedDoc {
	lines: string[];
	images: ImageMark[];
}

/** How the text around an inline token is styled, so a span's reset can restore it. */
interface Style {
	apply: (text: string) => string;
	/** The opening codes of `apply`, re-emitted after a nested span closes its own. */
	prefix: string;
}

const PLAIN: Style = { apply: (text) => text, prefix: "" };
const BULLETS = ["•", "◦", "▪"];
const HTML_COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

const parser = new Marked();

/** Render `text` to lines exactly `width` columns or less, plus where its images go. */
export function renderDoc(text: string, width: number, env: DocEnv): RenderedDoc {
	// SAFETY: every marked token has a `type`, and MdToken's other fields are optional.
	const tokens = parser.lexer(text.replace(/\t/g, "   ")) as unknown as MdToken[];
	env.images.beginPass();
	try {
		const out = new DocRenderer(env).blocks(tokens, Math.max(1, width), PLAIN, 0);
		trimBlank(out);
		return out;
	} finally {
		env.images.endPass();
	}
}

class DocRenderer {
	private readonly hyperlinks = getCapabilities().hyperlinks;
	private readonly occurrences = new Map<string, number>();

	constructor(private readonly env: DocEnv) {}

	blocks(all: readonly MdToken[], width: number, style: Style, depth: number): RenderedDoc {
		const out: RenderedDoc = { lines: [], images: [] };
		const tokens = withoutComments(all);
		tokens.forEach((token, i) => append(out, this.block(token, width, tokens[i + 1]?.type, style, depth)));
		return out;
	}

	private block(token: MdToken, width: number, next: string | undefined, style: Style, depth: number): RenderedDoc {
		const { md, theme } = this.env;
		const out: RenderedDoc = { lines: [], images: [] };
		// A blank line after a block, unless the source has one there anyway.
		const gap = () => {
			if (next && next !== "space") out.lines.push("");
		};
		switch (token.type) {
			case "heading": {
				const fn = headingStyle(token.depth ?? 1, md, theme);
				out.lines.push(...wrapTextWithAnsi(this.inline(token.tokens ?? [], styleOf(fn)), width));
				gap();
				break;
			}
			case "paragraph":
				append(out, this.paragraph(token.tokens ?? [], width, style));
				if (next !== "list") gap();
				break;
			case "text":
				// A tight list item's text.
				append(out, this.paragraph(token.tokens ?? [token], width, style));
				break;
			case "code": {
				const bar = md.codeBlockBorder("▎") + " ";
				const room = Math.max(1, width - 2);
				const code: string = token.text ?? "";
				const lines = md.highlightCode ? md.highlightCode(code, token.lang || undefined) : code.split("\n").map(md.codeBlock);
				for (const line of lines) for (const part of wrapTextWithAnsi(line, room)) out.lines.push(bar + part);
				gap();
				break;
			}
			case "list":
				append(out, this.list(token, width, style, depth));
				break;
			case "blockquote": {
				const fn = (text: string) => md.quote(md.italic(text));
				if (width < 3) {
					append(out, this.blocks(token.tokens ?? [], width, styleOf(fn), depth));
				} else {
					const inner = this.blocks(token.tokens ?? [], width - 2, styleOf(fn), depth);
					trimBlank(inner);
					append(out, indent(inner, md.quoteBorder("│ "), md.quoteBorder("│ ")));
				}
				gap();
				break;
			}
			case "table":
				// pi-tui draws tables with box lines and wraps cells to the width.
				out.lines.push(...new Markdown(token.raw ?? "", 0, 0, md).render(width).map((line: string) => line.trimEnd()));
				gap();
				break;
			case "hr":
				out.lines.push(md.hr("─".repeat(width)));
				gap();
				break;
			case "html": {
				const html = String(token.raw ?? "").replace(HTML_COMMENT, "").trim();
				if (html) {
					for (const line of html.split("\n")) out.lines.push(...wrapTextWithAnsi(style.apply(line), width));
					gap();
				}
				break;
			}
			case "space":
				out.lines.push("");
				break;
			case "checkbox":
				// Drawn as the item's marker by `list`.
				break;
			default:
				if (typeof token.text === "string") out.lines.push(...wrapTextWithAnsi(style.apply(token.text), width));
		}
		return out;
	}

	/** Running text, or images when that is all there is. */
	private paragraph(tokens: readonly MdToken[], width: number, style: Style): RenderedDoc {
		if (!isImageParagraph(tokens)) return { lines: wrapTextWithAnsi(this.inline(tokens, style), width), images: [] };
		const out: RenderedDoc = { lines: [], images: [] };
		for (const token of tokens) if (token.type === "image") append(out, this.image(token, width));
		return out;
	}

	private list(token: MdToken, width: number, style: Style, depth: number): RenderedDoc {
		const { md } = this.env;
		const out: RenderedDoc = { lines: [], images: [] };
		const items: MdToken[] = token.items ?? [];
		const start = typeof token.start === "number" ? token.start : 1;
		const numberWidth = token.ordered ? `${start + items.length - 1}.`.length : 1;
		items.forEach((item, i) => {
			let marker: string;
			if (item.task) marker = item.checked ? "☑" : "☐";
			else if (token.ordered) marker = `${start + i}.`.padStart(numberWidth);
			else marker = BULLETS[depth % BULLETS.length] ?? "•";
			const markerWidth = Math.max(visibleWidth(marker), numberWidth) + 1;
			const first = md.listBullet(marker.padEnd(markerWidth));
			const content = this.blocks(item.tokens ?? [], Math.max(1, width - markerWidth), style, depth + 1);
			trimBlank(content);
			if (content.lines.length === 0) content.lines.push("");
			append(out, indent(content, first, " ".repeat(markerWidth)));
			if (token.loose && i < items.length - 1) out.lines.push("");
		});
		return out;
	}

	/** A block image, or its placeholder line. */
	private image(token: MdToken, width: number): RenderedDoc {
		const out: RenderedDoc = { lines: [], images: [] };
		const href: string = token.href ?? "";
		const target = resolveImage(href, this.env.baseDir);
		let problem: ImageProblem | undefined;
		if (target.kind === "file" && imageProtocol()) {
			const seen = this.occurrences.get(target.path) ?? 0;
			this.occurrences.set(target.path, seen + 1);
			const placed = this.env.images.place(target.path, seen, width, this.env.maxImageRows);
			if (typeof placed !== "string") {
				out.images.push({ row: 0, rows: placed.rows, sequence: placed.sequence });
				for (let i = 0; i < placed.rows; i++) out.lines.push("");
				return out;
			}
			problem = placed;
		}
		const url = target.kind === "file" ? pathToFileURL(target.path).href : target.url;
		out.lines.push(...wrapTextWithAnsi(this.placeholder(token.text ?? "", href, url, problem), width));
		return out;
	}

	/** `🖼 alt · path`, and why it isn't drawn when that's a fault. */
	private placeholder(alt: string, shown: string, url: string, problem?: ImageProblem): string {
		const { theme } = this.env;
		const path = shown && this.hyperlinks ? hyperlink(shown, url) : shown;
		const parts = [`🖼 ${alt || "image"}`];
		if (shown) parts.push(path);
		const text = theme.fg("muted", parts.join(" · "));
		return problem ? `${text} ${theme.fg("warning", `(${PROBLEM_TEXT[problem]})`)}` : text;
	}

	private inline(tokens: readonly MdToken[], style: Style): string {
		const { md, theme } = this.env;
		// A newline inside a paragraph is a soft break: markdown joins it with a
		// space and the renderer rewraps to the panel. Only `br` breaks a line.
		const text = (raw: string) => style.apply(raw.replace(/[ \t]*\n[ \t]*/g, " "));
		let result = "";
		for (const token of tokens) {
			switch (token.type) {
				case "text":
					result += token.tokens?.length ? this.inline(token.tokens, style) : text(token.text ?? "");
					break;
				case "escape":
					result += text(token.text ?? "");
					break;
				case "strong":
					result += md.bold(this.inline(token.tokens ?? [], style)) + style.prefix;
					break;
				case "em":
					result += md.italic(this.inline(token.tokens ?? [], style)) + style.prefix;
					break;
				case "del":
					result += md.strikethrough(this.inline(token.tokens ?? [], style)) + style.prefix;
					break;
				case "codespan":
					result += md.code(token.text ?? "") + style.prefix;
					break;
				case "br":
					result += "\n";
					break;
				case "link": {
					const label = md.link(md.underline(this.inline(token.tokens ?? [], style)));
					const href: string = token.href ?? "";
					const bare = href.startsWith("mailto:") ? href.slice(7) : href;
					if (this.hyperlinks) result += hyperlink(label, href);
					else if (token.text === href || token.text === bare) result += label;
					else result += label + md.linkUrl(` (${href})`);
					result += style.prefix;
					break;
				}
				case "image":
					// An image inside running text: only its alt text, marked as an image.
					result += theme.fg("muted", `🖼 ${token.text || "image"}`) + style.prefix;
					break;
				case "html":
					if (token.raw && !token.raw.startsWith("<!--")) result += text(token.raw);
					break;
				case "checkbox":
					break;
				default:
					if (typeof token.text === "string") result += text(token.text);
			}
		}
		while (style.prefix && result.endsWith(style.prefix)) result = result.slice(0, -style.prefix.length);
		return result;
	}
}

const PROBLEM_TEXT: Record<ImageProblem, string> = {
	missing: "not found",
	unreadable: "can't read it",
	format: "not a PNG, JPEG, GIF or WebP",
	"too large": "too large to draw",
	"no png": "can't convert it to PNG for this terminal",
};

/** Level 1 underlined, 1–2 in the heading colour, 3 bold, 4 and below bold and muted. */
function headingStyle(level: number, md: MarkdownTheme, theme: Theme): (text: string) => string {
	if (level === 1) return (text) => md.heading(md.bold(md.underline(text)));
	if (level === 2) return (text) => md.heading(md.bold(text));
	if (level === 3) return (text) => md.bold(text);
	return (text) => theme.fg("muted", md.bold(text));
}

function styleOf(apply: (text: string) => string): Style {
	const sentinel = "\u0000";
	const styled = apply(sentinel);
	const at = styled.indexOf(sentinel);
	return { apply, prefix: at >= 0 ? styled.slice(0, at) : "" };
}

/** A paragraph of nothing but images (and the breaks between them) is drawn as images. */
function isImageParagraph(tokens: readonly MdToken[]): boolean {
	let images = 0;
	for (const token of tokens) {
		if (token.type === "image") images++;
		else if (token.type === "br" || (token.type === "text" && !token.tokens?.length && (token.text ?? "").trim() === "")) continue;
		else return false;
	}
	return images > 0;
}

/**
 * Drop html blocks that are only comments, and the blank line one leaves
 * behind, so a comment takes no room.
 */
function withoutComments(tokens: readonly MdToken[]): MdToken[] {
	const kept: MdToken[] = [];
	for (const token of tokens) {
		if (token.type === "html" && String(token.raw ?? "").replace(HTML_COMMENT, "").trim() === "") continue;
		if (token.type === "space" && kept.at(-1)?.type === "space") continue;
		kept.push(token);
	}
	return kept;
}

/** Add `src` below `dst`, moving its images down with it. */
function append(dst: RenderedDoc, src: RenderedDoc): void {
	const offset = dst.lines.length;
	dst.lines.push(...src.lines);
	for (const mark of src.images) dst.images.push({ ...mark, row: mark.row + offset });
}

/** Prefix the first line with `first` and every other with `rest`; images stay on their rows. */
function indent(block: RenderedDoc, first: string, rest: string): RenderedDoc {
	return { lines: block.lines.map((line, i) => (i === 0 ? first : rest) + line), images: block.images };
}

/** Drop trailing blank lines that aren't an image's rows. */
function trimBlank(block: RenderedDoc): void {
	const covered = (row: number) => block.images.some((m) => row >= m.row && row < m.row + m.rows);
	while (block.lines.length > 0 && block.lines.at(-1) === "" && !covered(block.lines.length - 1)) block.lines.pop();
}

/**
 * Adds a clickable "⧉ copy" label to code blocks, blockquotes and sections between two `---` rules
 * in assistant messages. Copies raw Markdown, or plain text (`"pi-copy-button": { "format": "plain" }` in
 * Pi's settings.json); Option/Alt- or Ctrl-click copies the other format.
 *
 * Pi has no hook for rendering assistant markdown, so this patches Pi internals:
 * `AssistantMessageComponent.updateContent` (to find each finished message's Markdown) and,
 * per Markdown instance, its private `renderToken`/`render` plus a `handleMouse`.
 * If those internals change, the guards below make it a no-op instead of breaking Pi.
 *
 * Clicks only reach components in fullscreen mode (`tuiMode: "fullscreen"`), so the labels
 * are hidden in the regular UI. Drag-selection keeps working: only plain clicks on a label
 * are handled.
 */
import { AssistantMessageComponent, copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, type TUI, TuiAltScreen, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import type { MarkedToken, Token } from "marked";

type Format = "raw" | "plain";
type Block = Record<Format, string>;
type Hit = { row: number; start: number; end: number; block: number };
type Copied = { block: number; label: string };

type MarkdownInternals = {
	renderToken(token: Token, width: number, nextTokenType?: string, styleContext?: unknown): string[];
	render(width: number): string[];
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
};
type AssistantInternals = {
	contentContainer?: { children: Component[] };
	isStreaming?: boolean;
	updateContent(...args: unknown[]): void;
};

const ORIGINAL = Symbol.for("pi-copy-button.updateContent");
type PatchedProto = AssistantInternals & { [ORIGINAL]?: AssistantInternals["updateContent"] };

// A zero-width OSC marker survives Markdown's wrapping and padding; we strip it before display.
const mark = (i: number) => `\x1b]7799;${i}\x07`;
const MARKER = /\x1b\]7799;(\d+)\x07/g;

const LABEL = "⧉ copy";
const DONE = "✓ copied";
const DONE_AS: Record<Format, string> = { raw: "✓ raw", plain: "✓ plain" };
const LABEL_WIDTH = Math.max(...[LABEL, DONE, ...Object.values(DONE_AS)].map((l) => visibleWidth(l))); // fixed column
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

let tui: TUI | undefined;
let ctx: ExtensionContext | undefined;
let format: Format = "raw";
const fullscreen = () => tui === undefined || tui instanceof TuiAltScreen;

function addButtons(md: Markdown): void {
	const self = md as unknown as MarkdownInternals;
	if (self.handleMouse) return;
	const base = Markdown.prototype as unknown as MarkdownInternals;
	if (typeof base.renderToken !== "function") return;

	let depth = 0;
	let blocks: Block[] = [];
	let section: Token[] | undefined; // top-level tokens since the last top-level rule
	let raw: string[] | undefined;
	let copied: Copied | undefined;
	let out: { raw: string[]; copied: Copied | undefined; lines: string[]; hits: Hit[] } | undefined;

	const addBlock = (block: Block, lines: string[]) => {
		const last = lines.findLastIndex((l) => l !== "");
		if (!block.raw || last === -1) return;
		lines[last] = mark(blocks.push(block) - 1) + lines[last];
	};

	self.renderToken = (token, width, nextTokenType, styleContext) => {
		const top = depth === 0;
		depth++;
		try {
			const lines = base.renderToken.call(md, token, width, nextTokenType, styleContext);
			if (!top) return lines;
			if (token.type === "hr") {
				// A rule closes the open section (label on this rule) and opens the next one.
				if (section) addBlock({ raw: section.map((t) => t.raw).join("").trim(), plain: blocksToPlain(section) }, lines);
				section = [];
				return lines;
			}
			section?.push(token);
			const t = token as MarkedToken;
			if (t.type === "code") addBlock({ raw: t.text, plain: t.text }, lines); // never fences, in either format
			if (t.type === "blockquote") addBlock({ raw: t.text, plain: blocksToPlain(t.tokens) }, lines);
			return lines;
		} finally {
			depth--;
		}
	};

	self.render = (width) => {
		const previous = blocks;
		blocks = [];
		section = undefined;
		const next = base.render.call(md, width);
		if (next === raw) blocks = previous; // Markdown's line cache: renderToken didn't run
		raw = next;
		if (out?.raw !== next || out.copied !== copied) out = { raw: next, copied, ...decorate(next, blocks, copied, width) };
		return out.lines;
	};

	self.handleMouse = (event) => {
		if (event.type !== "click" || event.button !== "left" || !out) return undefined;
		const hit = out.hits.find((h) => h.row === event.y && event.x >= h.start && event.x < h.end);
		const block = hit && blocks[hit.block];
		if (!hit || !block) return undefined;
		// Option/Alt (or Ctrl, which some terminals pass instead) copies the other format. Not Shift: terminals keep it for selection.
		const as: Format = event.alt || event.ctrl ? (format === "raw" ? "plain" : "raw") : format;
		const text = block[as];
		const done: Copied = { block: hit.block, label: as !== format && text !== block[format] ? DONE_AS[as] : DONE };
		void copyToClipboard(text).then(
			() => {
				copied = done;
				tui?.requestRender();
				setTimeout(() => {
					if (copied === done) copied = undefined;
					tui?.requestRender();
				}, 1500);
			},
			(error: unknown) => ctx?.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
		);
		return { handled: true };
	};
}

/** Plain text from Markdown tokens: the source without its syntax, so nothing is soft-wrapped. */
function blocksToPlain(tokens: Token[]): string {
	return tokens
		.map(blockToPlain)
		.filter((text) => text !== "")
		.join("\n\n");
}

function blockToPlain(token: Token): string {
	const t = token as MarkedToken;
	switch (t.type) {
		case "space":
		case "def":
		case "checkbox":
			return "";
		case "paragraph":
		case "heading":
			return inlineToPlain(t.tokens);
		case "text":
			return t.tokens ? inlineToPlain(t.tokens) : t.text;
		case "code":
			return t.text;
		case "blockquote":
			return blocksToPlain(t.tokens);
		case "hr":
			return "---";
		case "list":
			return t.items
				.map((item, i) => {
					const bullet = t.ordered ? `${(t.start === "" ? 1 : t.start) + i}. ` : "- ";
					const box = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
					const body = item.tokens
						.map(blockToPlain)
						.filter((text) => text !== "")
						.join(item.loose ? "\n\n" : "\n");
					return bullet + box + body.replaceAll("\n", `\n${" ".repeat(bullet.length)}`).replaceAll(/^ +$/gm, "");
				})
				.join(t.loose ? "\n\n" : "\n");
		case "table":
			return [t.header, ...t.rows].map((row) => row.map((cell) => inlineToPlain(cell.tokens)).join(" | ")).join("\n");
		case "html":
			return t.text.trim();
		default:
			return token.raw;
	}
}

function inlineToPlain(tokens: Token[]): string {
	return tokens
		.map((token) => {
			const t = token as MarkedToken;
			switch (t.type) {
				case "strong":
				case "em":
				case "del":
					return inlineToPlain(t.tokens);
				case "link": {
					const text = inlineToPlain(t.tokens);
					return text === t.href || `mailto:${text}` === t.href ? text : `${text} (${t.href})`;
				}
				case "text":
					return t.tokens ? inlineToPlain(t.tokens) : t.text;
				case "codespan":
				case "escape":
				case "image":
				case "html":
					return t.text;
				case "br":
					return "\n";
				default:
					return token.raw;
			}
		})
		.join("");
}

/** Strips markers and right-aligns a label on each block's last row (a code block's closing fence, a section's closing rule). */
function decorate(raw: string[], blocks: Block[], copied: Copied | undefined, width: number): { lines: string[]; hits: Hit[] } {
	const lines: string[] = [];
	const hits: Hit[] = [];
	const show = fullscreen();
	for (const line of raw) {
		const marks = [...line.matchAll(MARKER)];
		const clean = marks.length > 0 ? line.replace(MARKER, "") : line;
		const at = marks.find(([, i]) => blocks[Number(i)] !== undefined);
		if (!show || !at) {
			lines.push(clean);
			continue;
		}
		const block = Number(at[1]);
		const label = copied?.block === block ? copied.label : LABEL;
		const col = Math.max(0, width - LABEL_WIDTH - 1);
		const body = clean.trimEnd();
		const bodyWidth = visibleWidth(body);
		if (bodyWidth + 2 <= col) {
			hits.push({ row: lines.length, start: col, end: col + LABEL_WIDTH, block });
			lines.push(`${body}${" ".repeat(col - bodyWidth)}${dim(label.padEnd(LABEL_WIDTH))}${" ".repeat(Math.max(0, width - col - LABEL_WIDTH))}`);
		} else {
			// The last row is too long to share: right-align the label on its own row below.
			lines.push(clean);
			hits.push({ row: lines.length, start: col, end: col + LABEL_WIDTH, block });
			lines.push(`${" ".repeat(col)}${dim(label.padEnd(LABEL_WIDTH))}${" ".repeat(Math.max(0, width - col - LABEL_WIDTH))}`);
		}
	}
	return { lines, hits };
}

function patch(): void {
	const proto = AssistantMessageComponent.prototype as unknown as PatchedProto;
	const original = (proto[ORIGINAL] ??= proto.updateContent);
	if (typeof original !== "function") return;
	proto.updateContent = function (this: AssistantInternals, ...args: unknown[]) {
		original.apply(this, args);
		if (this.isStreaming) return;
		for (const child of this.contentContainer?.children ?? []) if (child instanceof Markdown) addButtons(child);
	};
}

/** `"pi-copy-button": { "format": "plain" }` in Pi's settings.json (global or project); anything else means raw. */
function configuredFormat(settings: object): Format {
	const ours: unknown = "pi-copy-button" in settings ? settings["pi-copy-button"] : undefined;
	return typeof ours === "object" && ours !== null && "format" in ours && ours.format === "plain" ? "plain" : "raw";
}

export default function (pi: ExtensionAPI) {
	patch();
	pi.on("session_start", async (_event, context) => {
		ctx = context;
		format = configuredFormat(pi.getSettings());
		if (!context.hasUI) return;
		// An empty widget: its factory is the only public way to reach the TUI (for requestRender and mode).
		context.ui.setWidget("pi-copy-button", (t) => {
			tui = t;
			return { render: () => [], invalidate: () => {} };
		});
	});
}

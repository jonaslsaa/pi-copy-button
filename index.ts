/**
 * Adds a clickable "⧉ copy" label to code blocks, blockquotes and sections between two `---` rules
 * in assistant messages. Copies raw markdown.
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

type Token = { type: string; text?: string; raw?: string };
type Block = { text: string };
type Hit = { row: number; start: number; end: number; block: number };

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
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

let tui: TUI | undefined;
let ctx: ExtensionContext | undefined;
const fullscreen = () => tui === undefined || tui instanceof TuiAltScreen;

function addButtons(md: Markdown): void {
	const self = md as unknown as MarkdownInternals;
	if (self.handleMouse) return;
	const base = Markdown.prototype as unknown as MarkdownInternals;
	if (typeof base.renderToken !== "function") return;

	let depth = 0;
	let blocks: Block[] = [];
	let section: string[] | undefined; // raw markdown since the last top-level rule
	let raw: string[] | undefined;
	let copied: number | undefined;
	let out: { raw: string[]; copied: number | undefined; lines: string[]; hits: Hit[] } | undefined;

	const addBlock = (text: string, lines: string[]) => {
		const last = lines.findLastIndex((l) => l !== "");
		if (!text || last === -1) return;
		lines[last] = mark(blocks.push({ text }) - 1) + lines[last];
	};

	self.renderToken = (token, width, nextTokenType, styleContext) => {
		const top = depth === 0;
		depth++;
		try {
			const lines = base.renderToken.call(md, token, width, nextTokenType, styleContext);
			if (!top) return lines;
			if (token.type === "hr") {
				// A rule closes the open section (label on this rule) and opens the next one.
				if (section) addBlock(section.join("").trim(), lines);
				section = [];
				return lines;
			}
			section?.push(token.raw ?? "");
			if (token.type === "code" || token.type === "blockquote") addBlock(token.text ?? "", lines);
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
		void copyToClipboard(block.text).then(
			() => {
				copied = hit.block;
				tui?.requestRender();
				setTimeout(() => {
					if (copied === hit.block) copied = undefined;
					tui?.requestRender();
				}, 1500);
			},
			(error: unknown) => ctx?.ui.notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
		);
		return { handled: true };
	};
}

/** Strips markers and right-aligns a label on each block's last row (a code block's closing fence, a section's closing rule). */
function decorate(raw: string[], blocks: Block[], copied: number | undefined, width: number): { lines: string[]; hits: Hit[] } {
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
		const label = copied === block ? DONE : LABEL;
		const labelWidth = Math.max(visibleWidth(LABEL), visibleWidth(DONE)); // fixed column, so "copied" doesn't shift
		const col = Math.max(0, width - labelWidth - 1);
		const body = clean.trimEnd();
		const bodyWidth = visibleWidth(body);
		if (bodyWidth + 2 <= col) {
			hits.push({ row: lines.length, start: col, end: col + labelWidth, block });
			lines.push(`${body}${" ".repeat(col - bodyWidth)}${dim(label.padEnd(labelWidth))}${" ".repeat(Math.max(0, width - col - labelWidth))}`);
		} else {
			// The last row is too long to share: right-align the label on its own row below.
			lines.push(clean);
			hits.push({ row: lines.length, start: col, end: col + labelWidth, block });
			lines.push(`${" ".repeat(col)}${dim(label.padEnd(labelWidth))}${" ".repeat(Math.max(0, width - col - labelWidth))}`);
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

export default function (pi: ExtensionAPI) {
	patch();
	pi.on("session_start", async (_event, context) => {
		ctx = context;
		if (!context.hasUI) return;
		// An empty widget: its factory is the only public way to reach the TUI (for requestRender and mode).
		context.ui.setWidget("pi-copy-button", (t) => {
			tui = t;
			return { render: () => [], invalidate: () => {} };
		});
	});
}

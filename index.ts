/**
 * Adds a clickable "⧉ copy" label to code blocks and blockquotes in assistant messages.
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

type Token = { type: string; text?: string };
type Kind = "code" | "quote";
type Block = { kind: Kind; text: string };
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

// Zero-width OSC markers survive Markdown's wrapping and padding; we strip them before display.
const start = (i: number) => `\x1b]7799;s${i}\x07`;
const end = (i: number) => `\x1b]7799;e${i}\x07`;
const MARKER = /\x1b\]7799;([se])(\d+)\x07/g;

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
	let raw: string[] | undefined;
	let copied: number | undefined;
	let out: { raw: string[]; copied: number | undefined; lines: string[]; hits: Hit[] } | undefined;

	self.renderToken = (token, width, nextTokenType, styleContext) => {
		const top = depth === 0;
		depth++;
		try {
			const lines = base.renderToken.call(md, token, width, nextTokenType, styleContext);
			const kind: Kind | undefined = token.type === "code" ? "code" : token.type === "blockquote" ? "quote" : undefined;
			if (top && kind && token.text && lines.some((l) => l !== "")) {
				const i = blocks.push({ kind, text: token.text }) - 1;
				const last = lines.findLastIndex((l) => l !== "");
				lines[0] = start(i) + lines[0];
				lines[last] = end(i) + lines[last];
			}
			return lines;
		} finally {
			depth--;
		}
	};

	self.render = (width) => {
		const previous = blocks;
		blocks = [];
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

/** Strips markers and puts a label after the content of each block's first (code) or last (quote) row. */
function decorate(raw: string[], blocks: Block[], copied: number | undefined, width: number): { lines: string[]; hits: Hit[] } {
	const lines: string[] = [];
	const hits: Hit[] = [];
	const show = fullscreen();
	for (const line of raw) {
		const marks = [...line.matchAll(MARKER)];
		const clean = marks.length > 0 ? line.replace(MARKER, "") : line;
		const at = marks.find(([, edge, i]) => blocks[Number(i)]?.kind === (edge === "s" ? "code" : "quote"));
		if (!show || !at) {
			lines.push(clean);
			continue;
		}
		const block = Number(at[2]);
		const label = copied === block ? DONE : LABEL;
		const body = clean.trimEnd();
		const col = visibleWidth(body) + 2;
		const labelWidth = visibleWidth(label);
		if (col + labelWidth <= width) {
			hits.push({ row: lines.length, start: col, end: col + labelWidth, block });
			lines.push(`${body}  ${dim(label)}${" ".repeat(width - col - labelWidth)}`);
		} else {
			// No room after a full-width quote line: put the label on its own row below.
			lines.push(clean);
			const indent = Math.min(2, Math.max(0, width - labelWidth));
			hits.push({ row: lines.length, start: indent, end: indent + labelWidth, block });
			lines.push(`${" ".repeat(indent)}${dim(label)}${" ".repeat(Math.max(0, width - indent - labelWidth))}`);
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

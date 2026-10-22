# pi-copy-button

Click `⧉ copy` next to a code block or a blockquote in Pi's transcript to copy it.

- Code blocks: label on the opening fence; copies the code without fences or indent.
- Blockquotes: label after the quote's last line; copies the quote's Markdown without the `>` markers.
- Shows `✓ copied` for 1.5s. Plain clicks elsewhere and drag-selection behave as before.
- Fullscreen TUI only (Pi's default `tuiMode`); hidden in regular mode, where the terminal owns the mouse.
- Labels appear once a message has finished streaming. Only assistant replies, not thinking or your own messages.

Install: `pi install ~/Documents/Personal/pi-copy-button`

## How (hacky)

Pi has no hook for assistant markdown rendering, so `index.ts` wraps `AssistantMessageComponent.prototype.updateContent`
and, per finished message's `Markdown`, its private `renderToken`/`render`, and adds `handleMouse`.
Top-level `code`/`blockquote` tokens get a zero-width OSC marker on their first/last line, which survives wrapping;
`render` strips the markers and draws the label there. Built against Pi 1.4.0; a Pi update that renames these
internals turns it into a no-op rather than breaking Pi.

Typecheck: `tsc -p .` (paths point at the installed Pi 1.4.0 typings).

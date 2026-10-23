# pi-copy-button

Click `⧉ copy` next to a code block, a blockquote or a section between two `---` rules in [Pi](https://github.com/earendil-works/pi)'s transcript to copy it.

![Pi transcript with a "⧉ copy" label on a code block and "✓ copied" on a quote](https://raw.githubusercontent.com/jonaslsaa/pi-copy-button/main/docs/screenshot.png)

```
pi install npm:pi-copy-button
```

- The label sits right-aligned on the block's last line, and shows `✓ copied` for 1.5s.
- Code blocks copy the code without fences or indent. Quotes copy their Markdown without the `>` markers. Sections (handy for drafts) copy the raw Markdown between the rules; the label sits on the closing rule.
- Only finished assistant replies get labels (not thinking, not your own messages).
- Fullscreen TUI only (Pi's default `tuiMode`). In regular mode the terminal owns the mouse.
- Plain clicks elsewhere and drag-selection work as before.

## How it works (hacky)

Pi has no public hook for rendering parts of assistant messages ([earendil-works/pi#11276](https://github.com/earendil-works/pi/issues/11276)),
so `index.ts` wraps `AssistantMessageComponent.prototype.updateContent` and, for each finished message's `Markdown`,
its private `renderToken`/`render`, and adds `handleMouse`. Top-level `code`/`blockquote` tokens and `hr`-delimited sections get a zero-width
marker on their last line, which survives wrapping; `render` strips it and draws the label there.

Built against Pi 1.4.0. If a Pi update renames these internals, the labels just disappear; Pi keeps working.

## Releasing

Bump `version` in `package.json`, merge, then publish a GitHub release tagged `v<version>`.
The Publish workflow waits for approval and publishes to npm with trusted publishing (no token).

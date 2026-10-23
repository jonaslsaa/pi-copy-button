import assert from "node:assert/strict";
import { test } from "node:test";
import { Lexer } from "marked";
import { blocksToPlain } from "../plain.ts";

const plain = (markdown: string) => blocksToPlain(Lexer.lex(markdown));

test("drops Markdown syntax but keeps the source's line breaks", () => {
	assert.equal(plain("# Hi team\nQuick **one** on `X-1`, _see_ [the doc](https://d.e) or <https://u.rl>.\n\n\nBye"), "Hi team\nQuick one on X-1, see the doc (https://d.e) or https://u.rl.\n\n\nBye");
	assert.equal(plain("- [x] done\n- two\n  3. three\n\n| a | b |\n|---|---|\n| 1 | **2** |"), "- [x] done\n- two\n  3. three\n\na | b\n1 | 2");
});

test("keeps code content, including a fenced block's trailing blank line", () => {
	assert.equal(plain("```\nalpha\n\n```\nbeta"), "alpha\n\nbeta");
	assert.equal(plain("para\n\n    indented\nnext"), "para\n\nindented\nnext");
	assert.equal(plain("> ```\n> alpha\n>\n> ```\n> beta"), "alpha\n\nbeta");
});

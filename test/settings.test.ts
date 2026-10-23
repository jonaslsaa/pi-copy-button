import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { configuredFormat, saveFormat } from "../settings.ts";

const dirs: string[] = [];
const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-copy-button-"));
	dirs.push(dir);
	return dir;
};
const read = (file: string): object => JSON.parse(readFileSync(file, "utf8"));
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

test("keeps other keys and leaves no temp file behind", () => {
	const dir = tempDir();
	const file = join(dir, "settings.json");
	writeFileSync(file, JSON.stringify({ defaultModel: "x", packages: ["a"], "pi-copy-button": { other: 1 } }));
	saveFormat(file, "plain");
	assert.deepEqual(read(file), { defaultModel: "x", packages: ["a"], "pi-copy-button": { other: 1, format: "plain" } });
	assert.equal(configuredFormat(read(file)), "plain");
	saveFormat(file, "raw");
	assert.equal(configuredFormat(read(file)), "raw");
	assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

test("creates a missing settings.json", () => {
	const file = join(tempDir(), "agent", "settings.json");
	saveFormat(file, "plain");
	assert.deepEqual(read(file), { "pi-copy-button": { format: "plain" } });
});

test("refuses to overwrite a file that isn't a JSON object", () => {
	const file = join(tempDir(), "settings.json");
	writeFileSync(file, "{ broken");
	assert.throws(() => saveFormat(file, "plain"));
	assert.equal(readFileSync(file, "utf8"), "{ broken");
});

test("writes through a symlinked settings.json", () => {
	const dir = tempDir();
	writeFileSync(join(dir, "real.json"), "{}");
	symlinkSync(join(dir, "real.json"), join(dir, "settings.json"));
	saveFormat(join(dir, "settings.json"), "plain");
	assert.deepEqual(read(join(dir, "real.json")), { "pi-copy-button": { format: "plain" } });
});

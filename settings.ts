/** The copy format setting: `"pi-copy-button": { "format": "raw" | "plain" }` in Pi's settings.json. */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FORMATS = ["raw", "plain"] as const;
export type Format = (typeof FORMATS)[number];

const KEY = "pi-copy-button";

export const isFormat = (value: unknown): value is Format => FORMATS.some((f) => f === value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The configured default; anything but `"plain"` means raw. */
export function configuredFormat(settings: object): Format {
	const ours: unknown = KEY in settings ? settings[KEY] : undefined;
	return isRecord(ours) && ours.format === "plain" ? "plain" : "raw";
}

/**
 * Sets our `format` in a settings.json and keeps every other key. Writes a temp file next to it and renames it
 * over the original, so a crash never leaves half a file. Throws (writing nothing) if the file isn't a JSON object.
 */
export function saveFormat(file: string, format: Format): void {
	const target = existsSync(file) ? realpathSync(file) : file; // a symlinked settings.json (dotfiles) stays a symlink
	const current: unknown = existsSync(target) ? JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, "")) : {};
	if (!isRecord(current)) throw new Error(`${file} is not a JSON object`);
	const ours = current[KEY];
	const next = { ...current, [KEY]: { ...(isRecord(ours) ? ours : {}), format } };
	mkdirSync(dirname(target), { recursive: true });
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: existsSync(target) ? statSync(target).mode : 0o644 });
	renameSync(tmp, target);
}

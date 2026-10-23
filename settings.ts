/** The copy format setting: `"pi-copy-button": { "format": "raw" | "plain" }` in Pi's settings.json. */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

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
 * Sets our `format` in a settings.json and keeps every other key. Holds Pi's own settings lock (`<file>.lock`, via
 * proper-lockfile like Pi's FileSettingsStorage) from read to write, so a concurrent Pi save isn't lost, and writes a
 * temp file renamed over the original, so a crash never leaves half a file. Throws, writing nothing, if the file
 * isn't a JSON object or is a broken symlink.
 */
export function saveFormat(file: string, format: Format): void {
	// A symlinked settings.json (dotfiles) stays a symlink; realpath throws on a dangling one instead of replacing it.
	const target = lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(file) : file;
	mkdirSync(dirname(file), { recursive: true });
	const release = lock(file);
	try {
		const current: unknown = existsSync(target) ? JSON.parse(readFileSync(target, "utf8").replace(/^\uFEFF/, "")) : {};
		if (!isRecord(current)) throw new Error(`${file} is not a JSON object`);
		const ours = current[KEY];
		const next = { ...current, [KEY]: { ...(isRecord(ours) ? ours : {}), format } };
		const tmp = `${target}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: existsSync(target) ? statSync(target).mode : 0o644 });
		renameSync(tmp, target);
	} finally {
		release();
	}
}

/** Pi's settings lock: same path (`realpath: false`) and the same short synchronous retry as its FileSettingsStorage. */
function lock(file: string): () => void {
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(file, { realpath: false });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ELOCKED") || attempt === 10) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
}

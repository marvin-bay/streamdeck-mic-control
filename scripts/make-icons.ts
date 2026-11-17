/**
 * Generates the plugin's static images from the same vector icons the key uses.
 *   imgs/action.svg            action list icon (white glyph)
 *   imgs/key.svg               default key image (live, 60 %)
 *   imgs/plugin(@2x).png       plugin icon
 *   imgs/category(@2x).png     category icon
 * Run with: npm run icons   (Node ≥ 23 runs this TypeScript file directly)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderGlyph, renderKey } from "../src/render.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const imgs = path.join(root, "io.github.marvin-bay.miccontrol.sdPlugin", "imgs");
mkdirSync(imgs, { recursive: true });

writeFileSync(path.join(imgs, "action.svg"), renderGlyph("mic"));
writeFileSync(path.join(imgs, "key.svg"), renderKey({ status: "live", ringPct: 60 }, { set: "mic" }));

// PNGs (plugin + category icons must be bitmaps).
const tmp = mkdtempSync(path.join(tmpdir(), "mic-control-icons-"));
try {
	const glyph = path.join(tmp, "glyph.svg");
	writeFileSync(glyph, renderGlyph("mic"));
	const jobs: [string, number][] = [
		["plugin.png", 256],
		["plugin@2x.png", 512],
		["category.png", 28],
		["category@2x.png", 56],
	];
	for (const [name, size] of jobs) {
		execFileSync("swift", [path.join(root, "scripts", "svg2png.swift"), glyph, path.join(imgs, name), String(size)], {
			stdio: "inherit",
		});
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
console.log(`icons written to ${path.relative(root, imgs)}`);

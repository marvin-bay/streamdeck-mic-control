import { describe, expect, it } from "vitest";
import { ICON_SETS, isCustomImage, renderKey, type IconSet } from "../src/render.js";

const custom = { live: "data:image/png;base64,AAA", muted: "data:image/png;base64,BBB" };

describe("renderKey", () => {
	it("draws every icon set in every state", () => {
		for (const set of ICON_SETS as IconSet[]) {
			for (const status of ["live", "muted", "disconnected"] as const) {
				const svg = renderKey({ status, ringPct: 42 }, { set, custom });
				expect(svg).toMatch(/^<svg .*<\/svg>$/);
			}
		}
	});

	it("ring: red when live, grey when muted, none when disconnected", () => {
		expect(renderKey({ status: "live", ringPct: 30 }, { set: "mic" })).toContain('stroke="#E5322D"');
		expect(renderKey({ status: "muted", ringPct: 30 }, { set: "mic" })).toContain('stroke="#6B6B6B"');
		const off = renderKey({ status: "disconnected", ringPct: 30 }, { set: "mic" });
		expect(off).not.toContain("#E5322D");
		expect(off).not.toContain("stroke-dasharray");
	});

	it("custom image uses the live/muted variant", () => {
		expect(renderKey({ status: "live", ringPct: 1 }, { set: "custom", custom })).toContain(custom.live);
		expect(renderKey({ status: "muted", ringPct: 1 }, { set: "custom", custom })).toContain(custom.muted);
	});

	it("custom without image falls back to the default icon", () => {
		expect(renderKey({ status: "live", ringPct: 1 }, { set: "custom" })).not.toContain("<image");
	});

	it("validates custom images", () => {
		expect(isCustomImage(custom)).toBe(true);
		expect(isCustomImage({ live: "http://x", muted: "data:image/png;base64,A" })).toBe(false);
		expect(isCustomImage(null)).toBe(false);
	});
});

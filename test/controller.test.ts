import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicController, TIMING, type ControllerDeps } from "../src/controller.js";
import type { HelperCommand } from "../src/helper.js";

const UID = "dji-uid";

/** Simulated device with 30 steps, like the DJI Mic receiver. */
function quantize(v: number): number {
	return Math.round(Math.round(v * 30) / 30 * 10000) / 10000;
}

function setup(opts: Partial<{ defaultLevel: number; showPercent: boolean; shiftFive: boolean }> = {}) {
	const sent: HelperCommand[] = [];
	const levels: Record<string, number> = {};
	let device = 0.5;
	let now = 0;
	const deps: ControllerDeps = {
		send: (c) => {
			sent.push(c);
			if (c.cmd === "setLevel") device = quantize(c.value);
			if (c.cmd === "getLevel") queueMicrotask(() => ctl.onLevel(device));
		},
		invalidate: vi.fn(),
		loadLastLevel: (uid) => levels[uid],
		saveLastLevel: (uid, pct) => (levels[uid] = pct),
		deviceResolved: vi.fn(),
		showAlert: vi.fn(),
		openAccessibilitySettings: vi.fn(),
		now: () => now,
	};
	const ctl = new MicController(deps, { defaultLevel: 50, showPercent: true, shiftFive: true, accessNotice: ["Allow"], ...opts });
	ctl.onHelperStarted();
	ctl.onDevice(true, UID, "Wireless Mic Rx");
	return {
		ctl,
		deps,
		sent,
		levels,
		get device() {
			return device;
		},
		/** Device report (echo or System Settings). */
		report(v: number) {
			device = v;
			ctl.onLevel(v);
		},
		advance: async (ms: number) => {
			now += ms;
			await vi.advanceTimersByTimeAsync(ms);
		},
		press: async (ms: number) => {
			ctl.keyDown();
			now += ms;
			await vi.advanceTimersByTimeAsync(ms);
			ctl.keyUp();
		},
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("states", () => {
	it("disconnected without level, live above 0, muted at 0", () => {
		const t = setup();
		expect(t.ctl.status).toBe("disconnected");
		t.report(0.4);
		expect(t.ctl.status).toBe("live");
		expect(t.ctl.view()).toMatchObject({ status: "live", ringPct: 40 });
		t.report(0);
		expect(t.ctl.status).toBe("muted");
		// muted ring: grey up to the remembered level
		expect(t.ctl.view()).toMatchObject({ status: "muted", ringPct: 40 });
	});

	it("unplugging → disconnected, key does nothing", () => {
		const t = setup();
		t.report(0.4);
		t.ctl.onDevice(false);
		expect(t.ctl.status).toBe("disconnected");
		t.ctl.keyDown();
		t.ctl.keyUp();
		expect(t.deps.showAlert).toHaveBeenCalled();
		expect(t.sent.filter((c) => c.cmd === "setLevel")).toHaveLength(0);
	});
});

describe("short press: mute/unmute", () => {
	it("mutes and restores the previous level", async () => {
		const t = setup();
		t.report(0.4);
		await t.press(100);
		expect(t.sent).toContainEqual({ cmd: "setLevel", value: 0 });
		await t.advance(TIMING.settleMs + 10);
		expect(t.ctl.status).toBe("muted");
		await t.press(100);
		expect(t.sent.at(-1)).toEqual({ cmd: "setLevel", value: 0.4 });
		await t.advance(TIMING.settleMs + 10);
		expect(t.ctl.status).toBe("live");
		expect(t.ctl.displayPct).toBe(40);
	});

	it("without a remembered level → default 50 %", async () => {
		const t = setup();
		t.report(0);
		await t.press(50);
		expect(t.sent.at(-1)).toEqual({ cmd: "setLevel", value: 0.5 });
	});

	it("long hold without adjusting does not toggle", async () => {
		const t = setup();
		t.report(0.4);
		await t.press(TIMING.shortPressMs + 50);
		expect(t.sent.filter((c) => c.cmd === "setLevel")).toHaveLength(0);
		expect(t.sent.map((c) => c.cmd)).toEqual(["adjustStart", "adjustEnd"]);
	});
});

describe("adjust mode", () => {
	it("1 % steps despite a 30-step device, no toggle after adjusting", async () => {
		const t = setup();
		t.report(quantize(0.4));
		t.ctl.keyDown();
		for (let i = 0; i < 3; i++) t.ctl.onStep(1, false);
		expect(t.ctl.displayPct).toBe(43);
		await t.advance(TIMING.settleMs + 10);
		// device sits at 43.33 %, display keeps the value we set
		expect(t.device).toBeCloseTo(0.4333, 3);
		expect(t.ctl.displayPct).toBe(43);
		t.ctl.onStep(1, false);
		await t.advance(TIMING.settleMs + 10);
		expect(t.ctl.displayPct).toBe(44); // did not get stuck
		t.ctl.keyUp();
		expect(t.sent.filter((c) => c.cmd === "setLevel").at(-1)).toEqual({ cmd: "setLevel", value: 0.44 });
		expect(t.sent.at(-1)).toEqual({ cmd: "adjustEnd" });
		expect(t.ctl.status).toBe("live");
	});

	it("shift = ±5 %, can be disabled", () => {
		const t = setup();
		t.report(0.5);
		t.ctl.keyDown();
		t.ctl.onStep(1, true);
		expect(t.ctl.displayPct).toBe(55);
		t.ctl.options.shiftFive = false;
		t.ctl.onStep(1, true);
		expect(t.ctl.displayPct).toBe(56);
	});

	it("adjusting to 0 = mute, adjusting up from mute = unmute; bounds 0–100", async () => {
		const t = setup();
		t.report(0.02);
		t.ctl.keyDown();
		t.ctl.onStep(-5, false);
		expect(t.ctl.displayPct).toBe(0);
		expect(t.ctl.status).toBe("muted");
		t.ctl.onStep(1, true);
		expect(t.ctl.status).toBe("live");
		t.ctl.onStep(200, false);
		expect(t.ctl.displayPct).toBe(100);
	});

	it("steps without a held key are ignored", () => {
		const t = setup();
		t.report(0.5);
		t.ctl.onStep(1, false);
		expect(t.ctl.displayPct).toBe(50);
	});

	it("percentage while holding, hidden 1 s after release", async () => {
		const t = setup();
		t.report(0.5);
		t.ctl.keyDown();
		await t.advance(TIMING.shortPressMs + 10);
		expect(t.ctl.view().overlay).toBe("50%");
		t.ctl.keyUp();
		await t.advance(TIMING.overlayHideMs - 50);
		expect(t.ctl.view().overlay).toBe("50%");
		await t.advance(100);
		expect(t.ctl.view().overlay).toBeUndefined();
	});

	it("without Accessibility: notice while holding, toggle still works", async () => {
		const t = setup();
		t.report(0.5);
		t.ctl.onAccess(false);
		expect(t.ctl.view().badge).toBe(true);
		t.ctl.keyDown();
		t.ctl.onAccess(false, "adjust");
		await t.advance(TIMING.shortPressMs + 10);
		expect(t.ctl.view().notice).toBeDefined();
		expect(t.deps.openAccessibilitySettings).toHaveBeenCalledTimes(1);
		t.ctl.keyUp();
		await t.advance(TIMING.noticeMs);
		await t.press(100);
		expect(t.sent.filter((c) => c.cmd === "setLevel").at(-1)).toEqual({ cmd: "setLevel", value: 0 });
	});
});

describe("sync", () => {
	it("external change wins immediately and is remembered", async () => {
		const t = setup();
		t.report(quantize(0.4));
		t.ctl.keyDown();
		t.ctl.onStep(1, false);
		t.ctl.keyUp();
		await t.advance(TIMING.settleMs + 10);
		expect(t.ctl.displayPct).toBe(41);
		t.report(0.7); // System Settings
		expect(t.ctl.displayPct).toBe(70);
		expect(t.levels[UID]).toBe(70);
	});

	it("helper exit → disconnected", () => {
		const t = setup();
		t.report(0.5);
		t.ctl.onHelperExited();
		expect(t.ctl.status).toBe("disconnected");
	});
});

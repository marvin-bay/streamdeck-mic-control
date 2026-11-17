/**
 * State and interaction logic of one key – free of the Stream Deck SDK so it can be unit-tested.
 *
 * Principle: the device's input level is the single source of truth. "Muted" means exactly "level = 0".
 *
 * Quantisation: many USB devices round the level to their own steps (the DJI Mic receiver has 30
 * steps of 3.33 %). To keep 1 % steps working, the controller remembers the percentage it last set
 * together with the value the device turned it into ("intent"). As long as the device reports exactly
 * that value, the set percentage is shown; any other report (System Settings, another app) wins at once.
 */
import type { HelperCommand } from "./helper.js";
import { clampPct, type KeyStatus, type KeyView } from "./render.js";

export const TIMING = {
	/** Released before this (without adjusting) = mute toggle. */
	shortPressMs: 400,
	/** The percentage stays visible this long after releasing the key. */
	overlayHideMs: 1000,
	/** After our own setLevel, treat device reports as echoes for this long, then read back. */
	settleMs: 350,
	/** How long the Accessibility notice stays on the key. */
	noticeMs: 3000,
};

export const DEFAULT_UNMUTE_LEVEL = 50;
const EPS = 0.0005;

export interface ControllerOptions {
	defaultLevel: number;
	showPercent: boolean;
	shiftFive: boolean;
	/** Lines shown on the key when Accessibility permission is missing. */
	accessNotice: string[];
}

export interface ControllerDeps {
	send(cmd: HelperCommand): void;
	/** Request a redraw (throttled by the caller). */
	invalidate(): void;
	/** Read/persist the remembered level of a device. */
	loadLastLevel(uid: string): number | undefined;
	saveLastLevel(uid: string, pct: number): void;
	/** The device was found (possibly by name); lets the caller store its UID. */
	deviceResolved(uid: string, name: string): void;
	showAlert(): void;
	/** Ask for Accessibility permission (open System Settings). */
	openAccessibilitySettings(): void;
	now(): number;
}

export class MicController {
	private connected = false;
	private helperAlive = false;
	private uid: string | null = null;
	/** Level reported by the device, 0…1; null = unknown or not adjustable. */
	private level: number | null = null;
	private intent: { pct: number; dev: number } | null = null;
	/** Percentage we set ourselves while the device's report is still pending. */
	private pending: number | null = null;
	private awaitingVerify = false;
	private settleTimer: NodeJS.Timeout | null = null;

	private trusted: boolean | null = null;
	private adjustDenied = false;
	private accessRequested = false;

	private holding = false;
	private ignoreUp = false;
	private pressAt = 0;
	private adjusted = false;
	private holdTimer: NodeJS.Timeout | null = null;
	private overlayVisible = false;
	private overlayTimer: NodeJS.Timeout | null = null;
	private noticeVisible = false;
	private noticeTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly deps: ControllerDeps,
		public options: ControllerOptions,
	) {}

	// ---------- derived values ----------

	/** Displayed level in whole percent. */
	get displayPct(): number {
		if (this.pending !== null) return this.pending;
		if (this.level === null) return 0;
		if (this.intent && Math.abs(this.intent.dev - this.level) < EPS) return this.intent.pct;
		return clampPct(this.level * 100);
	}

	get status(): KeyStatus {
		if (!this.helperAlive || !this.connected || this.level === null) return "disconnected";
		const muted = this.pending !== null ? this.pending === 0 : this.level < EPS;
		return muted ? "muted" : "live";
	}

	/** Last known level > 0 of the current device (persisted). */
	get lastLevel(): number | undefined {
		return this.uid ? this.deps.loadLastLevel(this.uid) : undefined;
	}

	/** Level that unmute restores. */
	get restoreTarget(): number {
		const last = this.lastLevel;
		return last && last > 0 ? last : clampPct(this.options.defaultLevel) || DEFAULT_UNMUTE_LEVEL;
	}

	view(): KeyView {
		const status = this.status;
		const view: KeyView = {
			status,
			ringPct: status === "live" ? this.displayPct : status === "muted" ? this.restoreTarget : 0,
		};
		if (this.noticeVisible) view.notice = this.options.accessNotice;
		else if (this.overlayVisible && status !== "disconnected") view.overlay = `${this.displayPct}%`;
		if (this.trusted === false) view.badge = true;
		return view;
	}

	// ---------- helper events ----------

	onHelperStarted(): void {
		this.helperAlive = true;
	}

	onHelperExited(): void {
		this.helperAlive = false;
		this.connected = false;
		this.resetLevelState();
		this.deps.invalidate();
	}

	onDevice(connected: boolean, uid?: string, name?: string): void {
		this.connected = connected;
		this.resetLevelState();
		if (connected && uid) {
			this.uid = uid;
			this.deps.deviceResolved(uid, name ?? "");
		}
		this.deps.invalidate();
	}

	onLevel(value: number | null): void {
		this.level = value;
		if (value === null) {
			this.deps.invalidate();
			return;
		}
		if (this.settleTimer) return; // echo of our own change; display follows `pending`
		if (this.awaitingVerify && this.pending !== null) {
			this.intent = { pct: this.pending, dev: value };
			this.pending = null;
			this.awaitingVerify = false;
		} else if (this.intent && Math.abs(this.intent.dev - value) >= EPS) {
			this.intent = null; // changed from outside
		}
		if (this.status === "live") this.remember(this.displayPct);
		this.deps.invalidate();
	}

	onAccess(trusted: boolean, context?: string): void {
		this.trusted = trusted;
		if (trusted) this.adjustDenied = false;
		else if (context === "adjust") this.adjustDenied = true;
		this.deps.invalidate();
	}

	onStep(delta: number, shift: boolean): void {
		if (!this.holding || this.status === "disconnected") return;
		this.adjusted = true;
		this.clearHoldTimer();
		this.overlayVisible = this.options.showPercent;
		const step = shift && this.options.shiftFive ? 5 : 1;
		this.setPct(clampPct(this.displayPct + delta * step));
	}

	// ---------- key ----------

	keyDown(): void {
		if (this.status === "disconnected") {
			this.ignoreUp = true;
			this.deps.showAlert();
			return;
		}
		this.ignoreUp = false;
		this.holding = true;
		this.adjusted = false;
		this.adjustDenied = false;
		this.pressAt = this.deps.now();
		this.deps.send({ cmd: "adjustStart" });
		this.clearHoldTimer();
		this.holdTimer = setTimeout(() => this.onHoldThreshold(), TIMING.shortPressMs);
	}

	keyUp(): void {
		if (this.ignoreUp) {
			this.ignoreUp = false;
			return;
		}
		if (!this.holding) return;
		this.holding = false;
		this.clearHoldTimer();
		this.deps.send({ cmd: "adjustEnd" });
		const held = this.deps.now() - this.pressAt;
		if (!this.adjusted && held < TIMING.shortPressMs) this.toggle();
		if (this.overlayVisible) {
			if (this.overlayTimer) clearTimeout(this.overlayTimer);
			this.overlayTimer = setTimeout(() => {
				this.overlayTimer = null;
				this.overlayVisible = false;
				this.deps.invalidate();
			}, TIMING.overlayHideMs);
		}
	}

	toggle(): void {
		const status = this.status;
		if (status === "disconnected") return;
		if (status === "live") {
			this.remember(this.displayPct);
			this.setPct(0);
		} else {
			this.setPct(this.restoreTarget);
		}
	}

	/** Held without adjusting: make adjust mode visible, or report missing permission. */
	private onHoldThreshold(): void {
		this.holdTimer = null;
		if (!this.holding) return;
		if (this.adjustDenied || this.trusted === false) {
			this.showAccessNotice();
			return;
		}
		if (this.options.showPercent) {
			this.overlayVisible = true;
			this.deps.invalidate();
		}
	}

	private showAccessNotice(): void {
		this.noticeVisible = true;
		this.deps.showAlert();
		if (!this.accessRequested) {
			this.accessRequested = true;
			this.deps.send({ cmd: "requestAccess" });
			this.deps.openAccessibilitySettings();
		}
		if (this.noticeTimer) clearTimeout(this.noticeTimer);
		this.noticeTimer = setTimeout(() => {
			this.noticeTimer = null;
			this.noticeVisible = false;
			this.deps.invalidate();
		}, TIMING.noticeMs);
		this.deps.invalidate();
	}

	// ---------- setting the level ----------

	setPct(pct: number): void {
		const p = clampPct(pct);
		this.pending = p;
		this.awaitingVerify = false;
		if (p > 0) this.remember(p);
		this.deps.send({ cmd: "setLevel", value: p / 100 });
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			this.awaitingVerify = true;
			this.deps.send({ cmd: "getLevel" });
		}, TIMING.settleMs);
		this.deps.invalidate();
	}

	private remember(pct: number): void {
		if (pct > 0 && this.uid) this.deps.saveLastLevel(this.uid, pct);
	}

	private resetLevelState(): void {
		this.level = null;
		this.intent = null;
		this.pending = null;
		this.awaitingVerify = false;
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.settleTimer = null;
	}

	private clearHoldTimer(): void {
		if (this.holdTimer) clearTimeout(this.holdTimer);
		this.holdTimer = null;
	}

	dispose(): void {
		for (const t of [this.settleTimer, this.holdTimer, this.overlayTimer, this.noticeTimer]) if (t) clearTimeout(t);
		if (this.holding) this.deps.send({ cmd: "adjustEnd" });
	}
}

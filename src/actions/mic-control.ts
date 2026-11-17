/**
 * Action "Mic Control": for every visible key, one helper process, one MicController and
 * throttled drawing.
 */
import streamDeck, {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	type PropertyInspectorDidAppearEvent,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { DEFAULT_UNMUTE_LEVEL, MicController, type ControllerOptions } from "../controller.js";
import { Helper, type DeviceInfo, type HelperEvent } from "../helper.js";
import type { Strings } from "../i18n.js";
import {
	DEFAULT_ICON_SET,
	ICON_SETS,
	isCustomImage,
	isIconSet,
	renderKey,
	svgToDataUrl,
	type CustomImage,
	type IconChoice,
	type IconSet,
	type KeyView,
} from "../render.js";
import type { LastLevelStore } from "../store.js";

export const ACTION_UUID = "io.github.marvin-bay.miccontrol.mic";

export type MicSettings = {
	/** Empty = follow the system default input device. */
	deviceUid?: string;
	/** Last known name of `deviceUid`, only for display while it is unplugged. */
	deviceName?: string;
	defaultLevel?: number;
	showPercent?: boolean;
	shiftFive?: boolean;
	iconSet?: IconSet;
	customImage?: CustomImage;
};

const ACCESSIBILITY_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
/** At most ~20 images per second. */
const MIN_FRAME_MS = 50;

function options(s: MicSettings, text: Strings): ControllerOptions {
	const level = Number(s.defaultLevel);
	return {
		defaultLevel: Number.isFinite(level) && level > 0 ? Math.min(100, Math.round(level)) : DEFAULT_UNMUTE_LEVEL,
		showPercent: s.showPercent !== false,
		shiftFive: s.shiftFive !== false,
		accessNotice: text.accessNotice,
	};
}

function iconChoice(s: MicSettings): IconChoice {
	const set = isIconSet(s.iconSet) ? s.iconSet : DEFAULT_ICON_SET;
	if (set === "custom" && isCustomImage(s.customImage)) return { set, custom: s.customImage };
	return { set: set === "custom" ? DEFAULT_ICON_SET : set };
}

class KeyEntry {
	readonly controller: MicController;
	readonly helper: Helper;
	private lastSvg: string | null = null;
	private lastFrameAt = 0;
	private frameTimer: NodeJS.Timeout | null = null;
	private disposed = false;
	devices: DeviceInfo[] | null = null;
	trusted: boolean | null = null;
	current: { uid: string; name: string } | null = null;

	constructor(
		public action: KeyAction<MicSettings>,
		public settings: MicSettings,
		private readonly text: Strings,
		helperBinary: string,
		store: LastLevelStore,
		private readonly onInspectorData: (entry: KeyEntry) => void,
	) {
		const log = streamDeck.logger;
		this.controller = new MicController(
			{
				send: (cmd) => this.helper.send(cmd),
				invalidate: () => this.invalidate(),
				loadLastLevel: (uid) => store.get(uid),
				saveLastLevel: (uid, pct) => store.set(uid, pct),
				deviceResolved: (uid, name) => {
					this.current = { uid, name };
					// Keep the stored display name of a fixed device up to date.
					if (this.settings.deviceUid === uid && this.settings.deviceName !== name) {
						this.settings = { ...this.settings, deviceName: name };
						void this.action.setSettings(this.settings).catch((e: unknown) => log.warn(`setSettings: ${String(e)}`));
					}
					this.onInspectorData(this);
				},
				showAlert: () => void this.action.showAlert().catch(() => undefined),
				openAccessibilitySettings: () => void streamDeck.system.openUrl(ACCESSIBILITY_URL).catch(() => undefined),
				now: () => Date.now(),
			},
			options(settings, text),
		);
		this.helper = new Helper(helperBinary, (e) => this.onHelperEvent(e), log, () => [
			{ cmd: "setDevice", uid: this.settings.deviceUid || undefined },
		]);
	}

	private onHelperEvent(e: HelperEvent): void {
		const c = this.controller;
		switch (e.evt) {
			case "spawn":
				c.onHelperStarted();
				break;
			case "exit":
				c.onHelperExited();
				break;
			case "hello":
				streamDeck.logger.info(`helper started (pid ${e.pid}, own TCC context: ${e.disclaimed})`);
				break;
			case "device":
				if (e.connected) c.onDevice(true, e.uid, e.name);
				else {
					this.current = null;
					c.onDevice(false);
				}
				break;
			case "level":
				c.onLevel(e.value);
				break;
			case "step":
				c.onStep(e.delta, e.shift);
				break;
			case "access":
				this.trusted = e.trusted;
				c.onAccess(e.trusted, e.context);
				this.onInspectorData(this);
				break;
			case "devices":
				this.devices = e.list;
				this.onInspectorData(this);
				break;
			case "error":
				break;
		}
	}

	applySettings(next: MicSettings): void {
		const deviceChanged = (this.settings.deviceUid || "") !== (next.deviceUid || "");
		this.settings = next;
		this.controller.options = options(next, this.text);
		if (deviceChanged) this.helper.send({ cmd: "setDevice", uid: next.deviceUid || undefined });
		this.invalidate();
	}

	render(view: KeyView = this.controller.view()): string {
		return renderKey(view, iconChoice(this.settings));
	}

	/** Throttled redraw; only sets the image when it actually changed. */
	invalidate(): void {
		if (this.frameTimer || this.disposed) return;
		const wait = Math.max(0, this.lastFrameAt + MIN_FRAME_MS - Date.now());
		this.frameTimer = setTimeout(() => {
			this.frameTimer = null;
			if (this.disposed) return;
			this.lastFrameAt = Date.now();
			const svg = this.render();
			if (svg === this.lastSvg) return;
			this.lastSvg = svg;
			void this.action.setImage(svgToDataUrl(svg)).catch((err: unknown) => {
				this.lastSvg = null;
				streamDeck.logger.warn(`setImage: ${String(err)}`);
			});
		}, wait);
	}

	dispose(): void {
		this.disposed = true;
		if (this.frameTimer) clearTimeout(this.frameTimer);
		this.controller.dispose();
		this.helper.stop();
	}
}

@action({ UUID: ACTION_UUID })
export class MicControlAction extends SingletonAction<MicSettings> {
	private readonly keys = new Map<string, KeyEntry>();
	private piContext: string | null = null;

	constructor(
		private readonly helperBinary: string,
		private readonly store: LastLevelStore,
		private readonly text: Strings,
	) {
		super();
	}

	override onWillAppear(ev: WillAppearEvent<MicSettings>): void {
		if (!ev.action.isKey()) return;
		this.keys.get(ev.action.id)?.dispose();
		const entry = new KeyEntry(ev.action, ev.payload.settings ?? {}, this.text, this.helperBinary, this.store, (e) =>
			this.pushToInspector(e),
		);
		this.keys.set(ev.action.id, entry);
		entry.invalidate();
		entry.helper.start();
	}

	override onWillDisappear(ev: WillDisappearEvent<MicSettings>): void {
		this.keys.get(ev.action.id)?.dispose();
		this.keys.delete(ev.action.id);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<MicSettings>): void {
		this.keys.get(ev.action.id)?.applySettings(ev.payload.settings ?? {});
	}

	override onKeyDown(ev: KeyDownEvent<MicSettings>): void {
		this.keys.get(ev.action.id)?.controller.keyDown();
	}

	override onKeyUp(ev: KeyUpEvent<MicSettings>): void {
		this.keys.get(ev.action.id)?.controller.keyUp();
	}

	override onPropertyInspectorDidAppear(ev: PropertyInspectorDidAppearEvent<MicSettings>): void {
		this.piContext = ev.action.id;
		const entry = this.keys.get(ev.action.id);
		entry?.helper.send({ cmd: "checkAccess" });
		entry?.helper.send({ cmd: "listDevices" });
		if (entry) this.pushPreviews(entry);
	}

	override onSendToPlugin(ev: SendToPluginEvent<JsonValue, MicSettings>): void {
		const entry = this.keys.get(ev.action.id);
		const payload = ev.payload as JsonObject | null;
		if (!entry || !payload || typeof payload !== "object") return;
		this.piContext = ev.action.id;
		switch (payload.event) {
			case "listDevices":
				entry.helper.send({ cmd: "listDevices" });
				this.pushPreviews(entry);
				break;
			case "requestAccess":
				entry.helper.send({ cmd: "requestAccess" });
				void streamDeck.system.openUrl(ACCESSIBILITY_URL);
				break;
		}
	}

	/** Device list, current device and permission status for the Property Inspector. */
	private pushToInspector(entry: KeyEntry): void {
		if (this.piContext !== entry.action.id) return;
		void streamDeck.ui
			.sendToPropertyInspector({
				event: "state",
				devices: (entry.devices ?? []).map((d) => ({ ...d })),
				current: entry.current ? { ...entry.current } : null,
				trusted: entry.trusted,
			})
			.catch(() => undefined);
	}

	/** One rendered preview per icon set (live, 60 %), so the PI can show real thumbnails. */
	private pushPreviews(entry: KeyEntry): void {
		const previews: Record<string, string> = {};
		for (const set of ICON_SETS) {
			if (set === "custom" && !isCustomImage(entry.settings.customImage)) continue;
			const choice: IconChoice = set === "custom" ? { set, custom: entry.settings.customImage } : { set };
			previews[set] = svgToDataUrl(renderKey({ status: "live", ringPct: 60 }, choice));
		}
		void streamDeck.ui.sendToPropertyInspector({ event: "previews", previews }).catch(() => undefined);
	}
}

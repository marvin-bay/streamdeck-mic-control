/**
 * Remembered level (lastLevel) per device UID, persisted in the plugin's global settings.
 * Global rather than per key so the Property Inspector can't overwrite it when saving, and
 * several keys for the same device share one value.
 */
export interface GlobalSettingsIO {
	load(): Promise<Record<string, unknown>>;
	save(settings: Record<string, unknown>): Promise<void>;
}

const SAVE_DELAY_MS = 1000;

export class LastLevelStore {
	private levels: Record<string, number> = {};
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly io: GlobalSettingsIO,
		private readonly onError: (msg: string) => void,
	) {}

	async init(): Promise<void> {
		try {
			const g = await this.io.load();
			const raw = g.lastLevels;
			if (raw && typeof raw === "object") {
				for (const [uid, v] of Object.entries(raw as Record<string, unknown>)) {
					if (typeof v === "number" && v > 0 && v <= 100) this.levels[uid] ??= Math.round(v);
				}
			}
		} catch (err) {
			this.onError(`could not read global settings: ${String(err)}`);
		}
	}

	get(uid: string): number | undefined {
		return this.levels[uid];
	}

	set(uid: string, pct: number): void {
		if (this.levels[uid] === pct) return;
		this.levels[uid] = pct;
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.io.save({ lastLevels: { ...this.levels } }).catch((err: unknown) => this.onError(`save failed: ${String(err)}`));
		}, SAVE_DELAY_MS);
	}
}

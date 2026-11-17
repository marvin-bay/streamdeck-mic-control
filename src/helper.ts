/**
 * Runs the native helper (bin/mic-control-helper) as a child process and talks to it with
 * line-delimited JSON over stdin/stdout. If the helper dies unexpectedly it is restarted with backoff.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export type HelperCommand =
	| { cmd: "setDevice"; uid?: string; name?: string }
	| { cmd: "setLevel"; value: number }
	| { cmd: "getLevel" }
	| { cmd: "listDevices" }
	| { cmd: "adjustStart" }
	| { cmd: "adjustEnd" }
	| { cmd: "checkAccess" }
	| { cmd: "requestAccess" };

export interface DeviceInfo {
	uid: string;
	name: string;
	adjustable: boolean;
	isDefault: boolean;
}

export type HelperEvent =
	| { evt: "hello"; version: number; pid: number; disclaimed: boolean }
	| { evt: "level"; value: number | null }
	| { evt: "device"; connected: false }
	| { evt: "device"; connected: true; uid: string; name: string; adjustable: boolean; followsDefault: boolean }
	| { evt: "devices"; list: DeviceInfo[] }
	| { evt: "step"; delta: number; shift: boolean }
	| { evt: "access"; trusted: boolean; context?: "adjust" }
	| { evt: "error"; message: string }
	/** Synthetic, from the plugin side: process exited or (re)started. */
	| { evt: "exit"; code: number | null }
	| { evt: "spawn" };

export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export const HELPER_BINARY = "mic-control-helper";

export function helperPath(pluginDir: string): string {
	return path.join(pluginDir, "bin", HELPER_BINARY);
}

/** `streamdeck pack` drops the executable bit, so an installed plugin has to restore it. */
export function ensureExecutable(file: string, log: Logger): void {
	try {
		accessSync(file, constants.X_OK);
	} catch {
		try {
			chmodSync(file, 0o755);
			log.info(`made helper executable: ${file}`);
		} catch (err) {
			log.error(`could not make helper executable: ${String(err)}`);
		}
	}
}

export class Helper {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private stopped = false;
	private backoffMs = 500;
	private restartTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly binary: string,
		private readonly onEvent: (e: HelperEvent) => void,
		private readonly log: Logger,
		private readonly onStartup: () => HelperCommand[],
	) {}

	get running(): boolean {
		return this.proc !== null;
	}

	start(): void {
		this.stopped = false;
		if (this.proc) return;
		if (!existsSync(this.binary)) {
			this.log.error(`helper missing: ${this.binary} (run npm run build:helper)`);
			this.onEvent({ evt: "exit", code: null });
			return;
		}
		ensureExecutable(this.binary, this.log);
		const proc = spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] });
		this.proc = proc;
		const startedAt = Date.now();

		createInterface({ input: proc.stdout }).on("line", (line) => {
			let msg: HelperEvent;
			try {
				msg = JSON.parse(line) as HelperEvent;
			} catch {
				this.log.warn(`helper: unreadable line: ${line}`);
				return;
			}
			if (msg.evt === "error") this.log.warn(`helper: ${msg.message}`);
			this.onEvent(msg);
		});
		createInterface({ input: proc.stderr }).on("line", (line) => this.log.warn(`helper stderr: ${line}`));

		proc.on("error", (err) => this.log.error(`helper: ${String(err)}`));
		proc.on("exit", (code) => {
			if (this.proc === proc) this.proc = null;
			this.onEvent({ evt: "exit", code });
			if (this.stopped) return;
			if (Date.now() - startedAt > 10_000) this.backoffMs = 500; // ran for a while: reset backoff
			this.log.warn(`helper exited (code ${code}), restarting in ${this.backoffMs} ms`);
			this.restartTimer = setTimeout(() => this.start(), this.backoffMs);
			this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
		});

		this.onEvent({ evt: "spawn" });
		for (const c of this.onStartup()) this.send(c);
	}

	send(command: HelperCommand): void {
		if (!this.proc) return;
		try {
			this.proc.stdin.write(JSON.stringify(command) + "\n");
		} catch (err) {
			this.log.warn(`helper: send failed: ${String(err)}`);
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = null;
		const proc = this.proc;
		this.proc = null;
		if (!proc) return;
		proc.stdin.end(); // EOF makes the helper exit cleanly
		setTimeout(() => {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
		}, 500);
	}
}

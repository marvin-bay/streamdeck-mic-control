/**
 * Entry point of "Mic Control": load remembered levels, register the action.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";
import { MicControlAction } from "./actions/mic-control.js";
import { helperPath } from "./helper.js";
import { strings } from "./i18n.js";
import { LastLevelStore } from "./store.js";

streamDeck.logger.setLevel("info");
const log = streamDeck.logger;
process.on("unhandledRejection", (reason) => log.error(`unhandled rejection: ${String(reason)}`));

// bin/plugin.js lives in <uuid>.sdPlugin/bin/
const pluginDir = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

const store = new LastLevelStore(
	{
		load: () => streamDeck.settings.getGlobalSettings(),
		save: (s) => streamDeck.settings.setGlobalSettings(s as never),
	},
	(msg) => log.warn(msg),
);

let language: string | undefined;
try {
	language = streamDeck.info.application.language;
} catch {
	language = undefined;
}

streamDeck.actions.registerAction(new MicControlAction(helperPath(pluginDir), store, strings(language)));

await streamDeck.connect();
await store.init();

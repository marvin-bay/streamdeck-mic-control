/** The few strings the plugin draws on the key itself. Everything else lives in the manifest locales and the PI. */
const STRINGS = {
	en: { accessNotice: ["Allow", "Accessi-", "bility"] },
	de: { accessNotice: ["Bedienungs-", "hilfen", "freigeben"] },
} as const;

export type Strings = { accessNotice: string[] };

export function strings(language: string | undefined): Strings {
	const lang = (language ?? "en").slice(0, 2).toLowerCase();
	const s = lang in STRINGS ? STRINGS[lang as keyof typeof STRINGS] : STRINGS.en;
	return { accessNotice: [...s.accessNotice] };
}

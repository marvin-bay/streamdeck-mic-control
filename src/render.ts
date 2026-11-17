/**
 * Key image as SVG (144 × 144, @2x for 72 px keys): a donut ring around a microphone icon.
 * Only plain SVG features are used (no pathLength, no filters) because the Stream Deck renderer
 * does not support everything; the ring length is therefore computed from the circumference.
 *
 * This module has no imports so that scripts/make-icons.ts can run it directly with Node.
 */

export const COLORS = {
	track: "#2A2A2A",
	trackDisconnected: "#1A1A1A",
	live: "#E5322D",
	muted: "#6B6B6B",
	notice: "#F5A623",
	iconLive: "#EDEDED",
	iconMuted: "#6E6E6E",
} as const;

const SIZE = 144;
const C = SIZE / 2;
const MARGIN = 6; // ≈ 3 px on a 72 px key
const STROKE = SIZE * 0.1;
const RADIUS = C - MARGIN - STROKE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const ICON = SIZE * 0.55;

export type KeyStatus = "live" | "muted" | "disconnected";

// ---------- icon sets ----------

/** Built-in vector icons, drawn in a 100 × 100 box. `c` = foreground colour, background is black. */
const VECTOR_ICONS = {
	mic: (c: string) =>
		`<rect x="36" y="6" width="28" height="52" rx="14" fill="${c}"/>` +
		`<path d="M22 42 v4 a28 28 0 0 0 56 0 v-4" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>` +
		`<path d="M50 76 v14 M34 92 h32" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>`,
	studio: (c: string) =>
		`<rect x="30" y="4" width="40" height="60" rx="20" fill="${c}"/>` +
		`<path d="M34 22 h32 M33 32 h34 M34 42 h32" stroke="#000000" stroke-width="3.5"/>` +
		`<path d="M20 38 v8 a30 30 0 0 0 60 0 v-8" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round"/>` +
		`<path d="M50 76 v16 M32 94 h36" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round"/>`,
	headset: (c: string) =>
		`<path d="M18 56 v-8 a32 32 0 0 1 64 0 v8" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round"/>` +
		`<rect x="10" y="50" width="18" height="28" rx="7" fill="${c}"/>` +
		`<rect x="72" y="50" width="18" height="28" rx="7" fill="${c}"/>` +
		`<path d="M22 78 q2 14 24 14 h4" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round"/>` +
		`<circle cx="56" cy="92" r="6.5" fill="${c}"/>`,
	clip: (c: string) =>
		`<rect x="16" y="12" width="64" height="76" rx="20" fill="${c}"/>` +
		`<rect x="26" y="24" width="44" height="52" rx="12" fill="#000000" fill-opacity="0.22"/>` +
		`<rect x="82" y="36" width="7" height="24" rx="3.5" fill="${c}"/>` +
		`<circle cx="68" cy="20" r="3.5" fill="#000000" fill-opacity="0.5"/>`,
} as const;

export type VectorIconSet = keyof typeof VECTOR_ICONS;
export type IconSet = VectorIconSet | "custom";
export const ICON_SETS: readonly IconSet[] = ["mic", "studio", "headset", "clip", "custom"];
export const DEFAULT_ICON_SET: IconSet = "mic";

/** A user-supplied image, prepared by the Property Inspector (PNG data URLs, muted = grey and darker). */
export type CustomImage = {
	live: string;
	muted: string;
};

export interface IconChoice {
	set: IconSet;
	custom?: CustomImage;
}

export function isIconSet(v: unknown): v is IconSet {
	return typeof v === "string" && (ICON_SETS as readonly string[]).includes(v);
}

export function isCustomImage(v: unknown): v is CustomImage {
	const o = v as CustomImage | null;
	return (
		!!o &&
		typeof o === "object" &&
		typeof o.live === "string" &&
		typeof o.muted === "string" &&
		o.live.startsWith("data:image/") &&
		o.muted.startsWith("data:image/")
	);
}

/** Icon markup, placed in a box of size `size` at (x, y). */
export function iconMarkup(icon: IconChoice, status: KeyStatus, x: number, y: number, size: number): string {
	const opacity = status === "disconnected" ? 0.4 : 1;
	if (icon.set === "custom" && icon.custom) {
		const href = status === "live" ? icon.custom.live : icon.custom.muted;
		return (
			`<image x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${size.toFixed(2)}" height="${size.toFixed(2)}" ` +
			`opacity="${opacity}" preserveAspectRatio="xMidYMid meet" xlink:href="${href}" href="${href}"/>`
		);
	}
	const set: VectorIconSet = icon.set === "custom" || !(icon.set in VECTOR_ICONS) ? "mic" : icon.set;
	const draw = VECTOR_ICONS[set];
	const color = status === "live" ? COLORS.iconLive : COLORS.iconMuted;
	const s = size / 100;
	return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})" opacity="${opacity}">${draw(color)}</g>`;
}

// ---------- key ----------

export interface KeyView {
	status: KeyStatus;
	/** Ring fill in whole percent (0–100). */
	ringPct: number;
	/** Large number over the icon (adjust mode), e.g. "42%". */
	overlay?: string;
	/** Notice text (e.g. missing Accessibility permission); replaces the overlay. */
	notice?: string[];
	/** Small warning dot in the top-right corner (e.g. Accessibility not granted). */
	badge?: boolean;
}

export function clampPct(n: number): number {
	return Math.max(0, Math.min(100, Math.round(n)));
}

function ring(pct: number, color: string): string {
	const p = clampPct(pct);
	if (p <= 0) return "";
	const common = `cx="${C}" cy="${C}" r="${RADIUS.toFixed(3)}" fill="none" stroke="${color}" stroke-width="${STROKE}"`;
	if (p >= 100) return `<circle ${common}/>`;
	const len = (CIRCUMFERENCE * p) / 100;
	// A circle's stroke starts at 3 o'clock, clockwise → rotate by -90° to start at 12 o'clock.
	return (
		`<circle ${common} stroke-linecap="butt" stroke-dasharray="${len.toFixed(3)} ${CIRCUMFERENCE.toFixed(3)}" ` +
		`transform="rotate(-90 ${C} ${C})"/>`
	);
}

function text(lines: string[], fontSize: number): string {
	const lineH = fontSize * 1.1;
	const boxH = lineH * lines.length + 10;
	const longest = Math.max(...lines.map((l) => l.length));
	const boxW = Math.min(SIZE - 8, Math.max(64, longest * fontSize * 0.62 + 16));
	const top = C - boxH / 2;
	let out =
		`<rect x="${(C - boxW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" ` +
		`rx="10" ry="10" fill="#000000" fill-opacity="0.7"/>`;
	lines.forEach((line, i) => {
		const y = top + 5 + lineH * (i + 0.8);
		out +=
			`<text x="${C}" y="${y.toFixed(1)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" ` +
			`font-weight="bold" font-size="${fontSize}" fill="#FFFFFF">${escapeXml(line)}</text>`;
	});
	return out;
}

function escapeXml(s: string): string {
	return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function svgDocument(body: string, size = SIZE): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
		`width="${size}" height="${size}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`
	);
}

export function renderKey(view: KeyView, icon: IconChoice): string {
	const disconnected = view.status === "disconnected";
	let body =
		`<rect width="${SIZE}" height="${SIZE}" fill="#000000"/>` +
		`<circle cx="${C}" cy="${C}" r="${RADIUS.toFixed(3)}" fill="none" ` +
		`stroke="${disconnected ? COLORS.trackDisconnected : COLORS.track}" stroke-width="${STROKE}"/>`;
	if (!disconnected) body += ring(view.ringPct, view.status === "live" ? COLORS.live : COLORS.muted);
	body += iconMarkup(icon, view.status, C - ICON / 2, C - ICON / 2, ICON);

	if (view.notice?.length) body += text(view.notice, 17);
	else if (view.overlay) body += text([view.overlay], 40);
	if (view.badge) body += `<circle cx="${SIZE - 16}" cy="16" r="8" fill="${COLORS.notice}"/>`;
	return svgDocument(body);
}

/** Monochrome glyph (white on transparent) for action list / category / plugin icons. */
export function renderGlyph(set: VectorIconSet, color = "#FFFFFF"): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${VECTOR_ICONS[set](color)}</svg>`;
}

export function svgToDataUrl(svg: string): string {
	return "data:image/svg+xml;charset=utf8," + encodeURIComponent(svg);
}

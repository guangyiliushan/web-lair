import { m } from '$lib/paraglide/messages';

export type AlertType = 'note' | 'tip' | 'important' | 'warning' | 'caution';

export const ALERT_LABELS: Record<AlertType, () => string> = {
	note: () => m.editor_alert_note(),
	tip: () => m.editor_alert_tip(),
	important: () => m.editor_alert_important(),
	warning: () => m.editor_alert_warning(),
	caution: () => m.editor_alert_caution()
};

export const DEFAULT_ALERT_TYPE: AlertType = 'note';

/** Ordered alert set (spec 3.1) — the single source for UI option lists. */
export const ALERT_TYPES: readonly AlertType[] = ['note', 'tip', 'important', 'warning', 'caution'];

/**
 * Marker table: the closed set (case-insensitive) plus the migration aliases
 * fixed by the spec (8) — `success` -> TIP, `error`/`danger` -> CAUTION — and
 * the legacy callout name `info` -> NOTE.
 */
const ALERT_TYPE_LOOKUP: Record<string, AlertType> = {
	note: 'note',
	tip: 'tip',
	important: 'important',
	warning: 'warning',
	caution: 'caution',
	info: 'note',
	success: 'tip',
	error: 'caution',
	danger: 'caution'
};

/** Normalizes a marker/type name; unknown names return null (5). */
export function normalizeAlertType(raw: string): AlertType | null {
	return ALERT_TYPE_LOOKUP[raw.trim().toLowerCase()] ?? null;
}

/** The marker token at the start of a line/paragraph: `[!NOTE]` + trailing spaces. */
export const ALERT_MARKER_REGEX = /^\[!([A-Za-z]+)\]([ \t]*)/;

/**
 * Parses a marker at the start of `text` (the line/paragraph content after
 * any `>` prefix was stripped). Returns the normalized type and the rest of
 * the line; null when the text does not start with a known marker.
 */
export function parseAlertMarker(text: string): { type: AlertType; rest: string } | null {
	const match = ALERT_MARKER_REGEX.exec(text);
	if (!match) return null;
	const type = normalizeAlertType(match[1]);
	if (!type) return null;
	return { type, rest: text.slice(match[0].length) };
}

/**
 * 默认空段落 editor state JSON。
 * 嵌套编辑器初始化时使用此值。
 */
export function createDefaultAlertContent(): string {
	return JSON.stringify({
		root: {
			children: [
				{
					children: [],
					direction: null,
					format: '',
					indent: 0,
					type: 'paragraph',
					version: 1
				}
			],
			direction: null,
			format: '',
			indent: 0,
			type: 'root',
			version: 1
		}
	});
}

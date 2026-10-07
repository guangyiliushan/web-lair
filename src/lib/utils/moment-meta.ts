/**
 * Moments kind axis (micro-content plan §0.4): `life | tech | media | other`.
 * Single source for the CHECK whitelist consumers (public list filter, admin
 * parsing) so the app-side whitelist and the DB CHECK cannot drift.
 */
export const MOMENT_KINDS = ['life', 'tech', 'media', 'other'] as const;

export type MomentKind = (typeof MOMENT_KINDS)[number];

export function isMomentKind(value: string): value is MomentKind {
	return (MOMENT_KINDS as readonly string[]).includes(value);
}

/** Parse a raw value into a kind, or null - shared by the admin actions and the public list filter. */
export function parseMomentKind(raw: string): MomentKind | null {
	return isMomentKind(raw) ? raw : null;
}

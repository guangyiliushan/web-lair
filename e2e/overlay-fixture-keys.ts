/**
 * Shared fixture contract for the overlay e2e (ST-3 3c): the three GIF object
 * keys must stay in lockstep between the spec (registry rows + request
 * assertions) and scripts/e2e-overlay-fixtures.ts (byte publisher). Keys
 * satisfy KEY_PATTERN's directory backreference (`ab/ab…`).
 */
export const OVERLAY_FIXTURE_KEYS = {
	new: `ab/ab${'1'.repeat(62)}.gif`,
	mid: `ab/ab${'2'.repeat(62)}.gif`,
	old: `ab/ab${'3'.repeat(62)}.gif`
} as const;

/** The generated GIFs' pixel size (mirrored by the seeded files rows). */
export const OVERLAY_FIXTURE_DIMENSIONS = { width: 800, height: 600 } as const;

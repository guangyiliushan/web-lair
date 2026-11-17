import type { OwnerStatus, OwnerStatusKind } from './owner-status.ts';

/**
 * Runtime owner-presence contract.
 *
 * The live pipeline (ActivityWatch bridge -> token-protected publish endpoint
 * -> Valkey -> layout/read API) writes this shape. The header deliberately
 * consumes only this view model, so swapping the collector later does not
 * touch the component tree.
 */
export type OwnerPresenceState = 'online' | 'offline' | 'unknown';

export type OwnerNameTier = 'long' | 'medium' | 'short';

export interface OwnerPresenceApp {
	name: string;
	/** Same-origin URL, or an icon key. Empty falls back to the generic icon. */
	icon: string;
}

export interface OwnerPresence {
	state: OwnerPresenceState;
	activity: OwnerStatusKind | null;
	app: OwnerPresenceApp | null;
	updatedAt: string | null;
	lastSeenAt: string | null;
}

export const OWNER_NAME_LONG_MIN = 10;
/**
 * 6 keeps `mikoto` (the six-grapheme example) in the short tier.
 * The final inline-app-name guard is still `appNameFits`' ResizeObserver.
 */
export const OWNER_NAME_SHORT_MAX = 6;

/** Grapheme count: an emoji or a combining mark must not count as two names. */
export function ownerNameLength(name: string): number {
	const trimmed = name.trim();
	if (trimmed === '') return 0;
	try {
		if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
			const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
			return Array.from(segmenter.segment(trimmed)).length;
		}
	} catch {
		// Older runtimes fall through to code-point counting.
	}
	return Array.from(trimmed).length;
}

export function ownerNameTier(name: string): OwnerNameTier {
	const length = ownerNameLength(name);
	if (length >= OWNER_NAME_LONG_MIN) return 'long';
	if (length <= OWNER_NAME_SHORT_MAX) return 'short';
	return 'medium';
}

/** First grapheme (not the first UTF-16 unit) for avatar fallbacks. */
export function firstGrapheme(name: string): string {
	const trimmed = name.trim();
	if (trimmed === '') return '?';
	try {
		if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
			const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
			const first = segmenter.segment(trimmed)[Symbol.iterator]().next();
			if (!first.done) return first.value.segment;
		}
	} catch {
		// Older runtimes fall through to code-point splitting.
	}
	return Array.from(trimmed)[0] ?? '?';
}

/**
 * Adapter for the static `site.ownerStatus` setting.
 *
 * The setting is a manual fallback, not a live signal. Until the ActivityWatch
 * pipeline lands there is no fresh heartbeat, so the honest state is
 * `unknown` — never `online`/`offline` and never a green dot (D4/R-4/R-11).
 * `kind`/`detail`/`icon`/`href` resume only with real presence data.
 */
export function ownerPresenceFromStatus(status: OwnerStatus): OwnerPresence {
	void status;
	return {
		state: 'unknown',
		activity: null,
		app: null,
		updatedAt: null,
		lastSeenAt: null
	};
}

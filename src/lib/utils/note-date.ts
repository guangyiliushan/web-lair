import { formatDate } from './i18n';
import { isValidIanaTimeZone } from './timezone';

/**
 * Belongs-to date helpers (notes plan §8.2): a note is filed under its own
 * `tz` calendar day, falling back to `site.timezone`. Single point for every
 * surface (list, topic page, mega menu, timeline) so the same note cannot
 * show different dates per entry point (review finding). Invalid stored
 * `tz` values fall back too - a bad row must not 500 a whole list.
 */
export function noteDisplayTimeZone(tz: string | null | undefined, siteTz: string): string {
	return tz && isValidIanaTimeZone(tz) ? tz : siteTz;
}

/** Locale-aware display date for a note row (note `tz`, site-timezone fallback). */
export function noteDateLabel(
	publishedAt: Date,
	tz: string | null | undefined,
	siteTz: string
): string {
	return formatDate(publishedAt, { timeZone: noteDisplayTimeZone(tz, siteTz) });
}

/**
 * IANA timezone validation for `site.timezone` (options registry) and note
 * `tz` values: `Intl.DateTimeFormat` throws a RangeError on an unknown zone,
 * so constructing a probe formatter is the validator. Two deliberate guards:
 *
 * - `Intl.supportedValuesOf('timeZone')` must NOT be used as the whitelist -
 *   the canonical list omits 'UTC' (and 'Etc/UTC' style links), which are
 *   valid zones.
 * - UTC-offset strings ('+08:00', '-0500') are REJECTED even though Intl
 *   accepts them: PostgreSQL's `AT TIME ZONE` reads them as POSIX zones
 *   (sign flipped) or rejects the format outright, so a value that passes
 *   Intl can silently shift the belongs-to date by hours - or 500 the query
 *   (review round 1 finding).
 */
export function isValidIanaTimeZone(value: string): boolean {
	if (value.startsWith('+') || value.startsWith('-')) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

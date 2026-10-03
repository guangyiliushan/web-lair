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
 * - Domain caveat (review round 2, real-PG probe): this check is NOT equal
 *   to PostgreSQL's zoneinfo set - each side accepts names the other rejects
 *   ('Japan'/'US/Pacific'/'Asia/Calcutta' pass Intl but 500 PG; ICU also
 *   canonicalises 'Asia/Kolkata' differently). Write paths must additionally
 *   verify against `pg_timezone_names` when they land (batch 5); the sign
 *   guard above still closes the silent-shift class.
 */
const ianaValidityCache = new Map<string, boolean>();

export function isValidIanaTimeZone(value: string): boolean {
	if (value.startsWith('+') || value.startsWith('-')) return false;
	// Per-row callers (note date rendering) hit the same handful of zone
	// strings on every render; memoise the probe (bounded set by design).
	const cached = ianaValidityCache.get(value);
	if (cached !== undefined) return cached;
	let valid: boolean;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		valid = true;
	} catch {
		valid = false;
	}
	if (ianaValidityCache.size >= 500) ianaValidityCache.clear();
	ianaValidityCache.set(value, valid);
	return valid;
}

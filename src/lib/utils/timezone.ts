/**
 * isValidIanaTimeZone validates `site.timezone` (options registry) and note `tz`
 * values; a probe `Intl.DateTimeFormat` throws RangeError on an unknown zone.
 * Caveats: `Intl.supportedValuesOf('timeZone')` must NOT be the whitelist - it
 * omits 'UTC' and `Etc/UTC`-style links, which are valid zones. UTC-offset
 * strings ('+08:00', '-0500') are rejected though Intl accepts them:
 * PostgreSQL's `AT TIME ZONE` reads them as POSIX zones (sign flipped) or
 * rejects them outright, so a value passing Intl can shift the belongs-to date
 * by hours - or 500 the query. The check is not PostgreSQL's zoneinfo set
 * (probed on a real database): 'Japan' / 'US/Pacific' / 'Asia/Calcutta' pass
 * Intl but 500 PG, so write paths must additionally verify against
 * `pg_timezone_names`; the sign guard above still closes the silent-shift class.
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

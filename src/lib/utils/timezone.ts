/**
 * IANA timezone validation for `site.timezone` (options registry) and note
 * `tz` values: `Intl.DateTimeFormat` throws a RangeError on an unknown zone,
 * so constructing a probe formatter is the validator. Do NOT use
 * `Intl.supportedValuesOf('timeZone')` as the whitelist - the canonical list
 * deliberately omits 'UTC' (and 'Etc/UTC' style links), which are valid zones.
 */
export function isValidIanaTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

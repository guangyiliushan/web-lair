import { describe, expect, it } from 'vitest';
import { isValidIanaTimeZone } from './timezone';

describe('isValidIanaTimeZone', () => {
	it('accepts IANA zones including the UTC aliases supportedValuesOf omits', () => {
		expect(isValidIanaTimeZone('UTC')).toBe(true);
		expect(isValidIanaTimeZone('Etc/UTC')).toBe(true);
		expect(isValidIanaTimeZone('Asia/Taipei')).toBe(true);
	});

	it('rejects unknown zones, blank and padded strings', () => {
		expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
		expect(isValidIanaTimeZone('')).toBe(false);
		expect(isValidIanaTimeZone(' Asia/Taipei ')).toBe(false);
	});

	it('rejects UTC-offset strings that Intl alone would accept (POSIX trap)', () => {
		// PostgreSQL reads '+08:00' as a POSIX zone (sign flipped!) and rejects
		// '+0800' outright - both pass Intl, so the validator must say no.
		expect(isValidIanaTimeZone('+08:00')).toBe(false);
		expect(isValidIanaTimeZone('-0500')).toBe(false);
	});
});

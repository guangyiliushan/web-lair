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
});

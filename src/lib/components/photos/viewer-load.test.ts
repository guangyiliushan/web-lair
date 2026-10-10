import { describe, expect, it } from 'vitest';
import {
	FULL_AUTO_LIMIT_BYTES,
	formatBytes,
	isMeteredConnection,
	shouldLoadFullOnDemand
} from './viewer-load';

/** T16 policy branches (plan §4.5): threshold / saveData / 2G-class / unknown. */
describe('viewer-load policy', () => {
	it('locks the 8 MB threshold', () => {
		expect(FULL_AUTO_LIMIT_BYTES).toBe(8 * 1024 * 1024);
	});

	it('auto-loads at or below the threshold, on-demand above it', () => {
		expect(shouldLoadFullOnDemand(FULL_AUTO_LIMIT_BYTES, null)).toBe(false);
		expect(shouldLoadFullOnDemand(FULL_AUTO_LIMIT_BYTES + 1, null)).toBe(true);
		expect(shouldLoadFullOnDemand(1200, null)).toBe(false);
		expect(shouldLoadFullOnDemand(9_000_000, null)).toBe(true);
	});

	it('takes the auto path for unknown or non-finite sizes', () => {
		expect(shouldLoadFullOnDemand(null, null)).toBe(false);
		expect(shouldLoadFullOnDemand(Number.NaN, null)).toBe(false);
	});

	it('data-saver forces on-demand regardless of size', () => {
		expect(shouldLoadFullOnDemand(1200, { saveData: true })).toBe(true);
		expect(shouldLoadFullOnDemand(null, { saveData: true })).toBe(true);
		expect(isMeteredConnection({ saveData: true })).toBe(true);
	});

	it('2G-class effective types count as metered; 4G does not', () => {
		expect(isMeteredConnection({ effectiveType: 'slow-2g' })).toBe(true);
		expect(isMeteredConnection({ effectiveType: '2g' })).toBe(true);
		expect(isMeteredConnection({ effectiveType: '3g' })).toBe(false);
		expect(isMeteredConnection({ effectiveType: '4g' })).toBe(false);
		expect(isMeteredConnection({})).toBe(false);
		expect(isMeteredConnection(undefined)).toBe(false);
		expect(isMeteredConnection(null)).toBe(false);
	});

	it('formats byte sizes for the floater and the load button', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1023)).toBe('1023 B');
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(8 * 1024 * 1024)).toBe('8.0 MB');
		expect(formatBytes(9_000_000)).toBe('8.6 MB');
		expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
		expect(formatBytes(Number.NaN)).toBe('—');
		expect(formatBytes(-1)).toBe('—');
	});
});

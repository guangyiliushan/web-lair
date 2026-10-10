import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
	it('formats byte sizes for the viewer and the admin surfaces', () => {
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

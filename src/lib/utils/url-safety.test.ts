import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './url-safety';

/**
 * P closing review: the render-side URL filter is pinned here so a mutation
 * that weakens it (e.g. returning the value unconditionally) fails a unit
 * test, not only the e2e unsafe-row fixture. All browser URL parsers behave
 * like Node's for these forms (cross-checked in the closing review).
 */
describe('safeHttpUrl', () => {
	it('passes only http(s) through and preserves the original string', () => {
		expect(safeHttpUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
		expect(safeHttpUrl('http://example.com/')).toBe('http://example.com/');
		// The parser normalizes scheme case for the check; the original stays.
		expect(safeHttpUrl('HTTPS://EXAMPLE.COM/')).toBe('HTTPS://EXAMPLE.COM/');
		expect(safeHttpUrl(null)).toBeNull();
	});

	it('rejects every non-http(s) or unparseable form', () => {
		for (const value of [
			'javascript:alert(1)',
			'JavaScript:alert(1)',
			' JAVASCRIPT:alert(1)',
			'java\tscript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox(1)',
			'mailto:a@example.com',
			'//example.com/protocol-relative',
			'/relative/path',
			'foo',
			'https:javascript:alert(1)',
			'file:///etc/passwd'
		]) {
			expect(safeHttpUrl(value), value).toBeNull();
		}
	});
});

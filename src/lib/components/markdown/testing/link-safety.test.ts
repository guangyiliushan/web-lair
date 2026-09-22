import { describe, expect, it } from 'vitest';
import { isSafeLinkUrl } from '$lib/components/markdown/editor/lexical-helpers';

// Mirrors the render-side sanitize schema (markdown-config): the editor must
// not create links the render side would strip (javascript:, data:, ...).
describe('editor link safety (render-side parity)', () => {
	it('accepts the protocols the sanitize schema allows', () => {
		expect(isSafeLinkUrl('https://example.com')).toBe(true);
		expect(isSafeLinkUrl('http://example.com')).toBe(true);
		expect(isSafeLinkUrl('mailto:a@b.c')).toBe(true);
		expect(isSafeLinkUrl('tel:+123')).toBe(true);
	});

	it('rejects script and data protocols', () => {
		expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false);
		expect(isSafeLinkUrl('daTa:text/html,x')).toBe(false);
		expect(isSafeLinkUrl('/relative/path')).toBe(false);
	});
});

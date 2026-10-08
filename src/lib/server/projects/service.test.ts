import { describe, expect, it } from 'vitest';
import { canTransition, normalizeSiteUrl, requireHttpUrl, ProjectsServiceError } from './service';

/**
 * A-batch service pins (plan §4): the pure rules behind the admin surface.
 * DB paths (transitions applied, reorder, enqueue) are exercised end to end
 * by e2e/projects-admin.e2e.ts against the real database; what is pinned
 * here is the invariants table itself.
 */
describe('projects service invariants', () => {
	it('guards the four-value state machine exactly as planned (§4.2)', () => {
		expect(canTransition('pending', 'published')).toBe(true);
		expect(canTransition('pending', 'rejected')).toBe(true);
		expect(canTransition('published', 'hidden')).toBe(true);
		expect(canTransition('published', 'rejected')).toBe(true);
		expect(canTransition('hidden', 'published')).toBe(true);
		expect(canTransition('hidden', 'rejected')).toBe(true);
		expect(canTransition('rejected', 'pending')).toBe(true);
		// Everything else is refused - including same-state writes.
		for (const from of ['pending', 'published', 'hidden', 'rejected'] as const) {
			for (const to of ['pending', 'published', 'hidden', 'rejected'] as const) {
				const allowed =
					(from === 'pending' && (to === 'published' || to === 'rejected')) ||
					(from === 'published' && (to === 'hidden' || to === 'rejected')) ||
					(from === 'hidden' && (to === 'published' || to === 'rejected')) ||
					(from === 'rejected' && to === 'pending');
				expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed);
			}
		}
	});

	it('normalizes site/other links by host case and trailing slash (§2.8-4)', () => {
		expect(normalizeSiteUrl('https://Example.COM/')).toBe('https://example.com');
		expect(normalizeSiteUrl('https://example.com/path/')).toBe('https://example.com/path');
		expect(normalizeSiteUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
	});

	it('rejects non-http(s) URL fields on the write side', () => {
		expect(requireHttpUrl('  https://example.com/x  ')).toBe('https://example.com/x');
		expect(requireHttpUrl('')).toBeNull();
		expect(requireHttpUrl(null)).toBeNull();
		for (const bad of [
			'javascript:alert(1)',
			'data:text/html,x',
			'mailto:a@example.com',
			'//example.com',
			'/relative'
		]) {
			expect(() => requireHttpUrl(bad), bad).toThrow(ProjectsServiceError);
		}
	});
});

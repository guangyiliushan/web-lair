import { describe, expect, it } from 'vitest';
import { conditionalResponse, ifNoneMatchMatches } from './cache';

describe('ifNoneMatchMatches', () => {
	const etag = '"abc123"';

	it('matches exact, star and comma-separated lists (weak comparison)', () => {
		expect(ifNoneMatchMatches(etag, etag)).toBe(true);
		expect(ifNoneMatchMatches('*', etag)).toBe(true);
		expect(ifNoneMatchMatches('"other", "abc123"', etag)).toBe(true);
		expect(ifNoneMatchMatches('W/"abc123"', etag)).toBe(true);
		expect(ifNoneMatchMatches('  "abc123"  ', etag)).toBe(true);
	});

	it('does not match different or missing validators', () => {
		expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
		expect(ifNoneMatchMatches(null, etag)).toBe(false);
		expect(ifNoneMatchMatches('', etag)).toBe(false);
	});
});

describe('conditionalResponse', () => {
	const base = {
		contentType: 'application/xml; charset=utf-8',
		etag: '"abc123"',
		lastModified: new Date('2026-09-30T09:00:00Z')
	};

	it('answers 304 without a body on a matching If-None-Match', async () => {
		const response = conditionalResponse(
			new Request('http://localhost/feed.xml', { headers: { 'if-none-match': base.etag } }),
			'<feed/>',
			base
		);

		expect(response.status).toBe(304);
		expect(await response.text()).toBe('');
		expect(response.headers.get('etag')).toBe(base.etag);
		expect(response.headers.get('last-modified')).toBe('Wed, 30 Sep 2026 09:00:00 GMT');
		expect(response.headers.get('cache-control')).toBe('public, max-age=300');
	});

	it('answers 200 with the body when the validator differs or is absent', async () => {
		const cases: Record<string, string>[] = [{}, { 'if-none-match': '"other"' }];
		for (const headers of cases) {
			const response = conditionalResponse(
				new Request('http://localhost/feed.xml', { headers }),
				'<feed/>',
				base
			);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('<feed/>');
		}
	});

	it('never 304s on If-Modified-Since alone (LM is informational; review round 2)', () => {
		const response = conditionalResponse(
			new Request('http://localhost/feed.xml', {
				headers: { 'if-modified-since': 'Wed, 30 Sep 2026 09:00:00 GMT' }
			}),
			'<feed/>',
			base
		);
		expect(response.status).toBe(200);
	});

	it('omits Last-Modified when there is no reliable date', () => {
		const response = conditionalResponse(new Request('http://localhost/feed.xml'), '<feed/>', {
			...base,
			lastModified: null
		});
		expect(response.headers.get('last-modified')).toBeNull();
	});
});

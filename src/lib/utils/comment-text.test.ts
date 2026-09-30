import { describe, expect, it } from 'vitest';
import { parseCommentText } from './comment-text';

describe('parseCommentText', () => {
	it('returns nothing for empty input and plain text stays one segment', () => {
		expect(parseCommentText('')).toEqual([]);
		expect(parseCommentText('hello 世界')).toEqual([{ type: 'text', text: 'hello 世界' }]);
	});

	it('splits the text around URLs in every position', () => {
		expect(parseCommentText('https://example.com done')).toEqual([
			{ type: 'link', text: 'https://example.com', href: 'https://example.com/' },
			{ type: 'text', text: ' done' }
		]);
		expect(parseCommentText('see https://example.com/x here')).toEqual([
			{ type: 'text', text: 'see ' },
			{ type: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
			{ type: 'text', text: ' here' }
		]);
		expect(parseCommentText('tail https://example.com')).toEqual([
			{ type: 'text', text: 'tail ' },
			{ type: 'link', text: 'https://example.com', href: 'https://example.com/' }
		]);
	});

	it('trims sentence punctuation and unmatched brackets from the tail', () => {
		const cases: Array<[string, string]> = [
			['go https://example.com/a.', 'https://example.com/a'],
			['go https://example.com/a,', 'https://example.com/a'],
			['(see https://example.com/a)', 'https://example.com/a'],
			['(see https://example.com/a(b))', 'https://example.com/a(b)'],
			['（见 https://example.com/a）', 'https://example.com/a'],
			['看这个 https://example.com/a。', 'https://example.com/a']
		];
		for (const [input, expected] of cases) {
			const link = parseCommentText(input).find((segment) => segment.type === 'link');
			expect(link?.text, input).toBe(expected);
		}
	});

	it('keeps query strings and fragments intact', () => {
		const [link] = parseCommentText('https://example.com/a?b=1&c=2#frag');
		expect(link.type).toBe('link');
		expect(link.href).toBe('https://example.com/a?b=1&c=2#frag');
	});

	it('normalises the scheme case and adds the root slash', () => {
		const [link] = parseCommentText('HTTPS://EXAMPLE.COM');
		expect(link.type).toBe('link');
		expect(link.href).toBe('https://example.com/');
	});

	it('leaves non-http(s) and unparseable candidates as literal text', () => {
		const inputs = [
			'ftp://example.com/x',
			'javascript:alert(1)',
			'https://',
			'a https://: b',
			'mail us at x@example.com'
		];
		for (const input of inputs) {
			const segments = parseCommentText(input);
			expect(
				segments.every((segment) => segment.type === 'text'),
				input
			).toBe(true);
			// Nothing was dropped or reordered: the text rejoins to the input.
			expect(segments.map((segment) => segment.text).join(''), input).toBe(input);
		}
	});

	it('never emits raw quotes or angle brackets into the href', () => {
		const segments = parseCommentText('x https://example.com/"><b>tail');
		const link = segments.find((segment) => segment.type === 'link');
		expect(link).toBeTruthy();
		expect(link?.href ?? '').not.toContain('"');
		expect(link?.href ?? '').not.toContain('<');
		expect(link?.href ?? '').not.toContain('>');
	});

	it('handles multiple URLs and rejoins to the original text', () => {
		const input = 'a https://x.com/1 b https://y.com/2. tail';
		const segments = parseCommentText(input);
		expect(segments.filter((segment) => segment.type === 'link')).toHaveLength(2);
		expect(segments.map((segment) => segment.text).join('')).toBe(input);
	});

	it('downgrades confusable candidates (backslash / userinfo) to text', () => {
		// Display-vs-target confusion vectors (security review).
		const inputs = ['https://evil.com\\@trusted.com/x', 'https://trusted.com@evil.com/x'];
		for (const input of inputs) {
			const segments = parseCommentText(input);
			expect(
				segments.every((segment) => segment.type === 'text'),
				input
			).toBe(true);
			expect(segments.map((segment) => segment.text).join(''), input).toBe(input);
		}
	});

	it('downgrades loopback and private-network hosts to text', () => {
		const inputs = [
			'https://127.0.0.1/x',
			'https://[::1]/',
			'https://localhost/x',
			'https://router.local/setup',
			'https://192.168.1.1/admin',
			'https://10.1.2.3/x',
			'https://169.254.169.254/latest'
		];
		for (const input of inputs) {
			expect(
				parseCommentText(input).every((segment) => segment.type === 'text'),
				input
			).toBe(true);
		}
	});

	it('still links normal public hosts, including mastodon-style handles', () => {
		const [link] = parseCommentText('https://mastodon.social/@user');
		expect(link.type).toBe('link');
		expect(link.href).toBe('https://mastodon.social/@user');
	});
});

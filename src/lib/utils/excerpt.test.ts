import { describe, expect, it } from 'vitest';
import { firstImageFromMarkdown, plainTextExcerpt } from './excerpt';

describe('plainTextExcerpt', () => {
	it('trims plain text and collapses whitespace', () => {
		expect(plainTextExcerpt('  Hello   world \n\n again  ')).toBe('Hello world again');
	});

	it('strips headings, emphasis, inline code and links', () => {
		expect(
			plainTextExcerpt('## Title\n\nSome **bold**, `code` and [link](https://example.com)')
		).toBe('Title Some bold, code and link');
	});

	it('drops fenced code blocks entirely', () => {
		expect(plainTextExcerpt('before\n```js\nconst a = 1;\n```\nafter')).toBe('before after');
	});

	it('reduces images to their alt text', () => {
		expect(plainTextExcerpt('Look ![a cat](https://example.com/cat.png) here')).toBe(
			'Look a cat here'
		);
	});

	it('truncates long text with a trailing ellipsis', () => {
		const long = 'word '.repeat(60).trim();
		const out = plainTextExcerpt(long, 50);
		expect(out.length).toBeLessThanOrEqual(51);
		expect(out.endsWith('…')).toBe(true);
	});

	it('leaves short CJK text intact', () => {
		expect(plainTextExcerpt('中文段落，无空格。')).toBe('中文段落，无空格。');
	});

	it('returns an empty string for empty input', () => {
		expect(plainTextExcerpt('')).toBe('');
	});

	it('strips blockquote and list markers', () => {
		expect(plainTextExcerpt('> quoted\n- item\n1. item')).toBe('quoted item item');
	});

	it('strips strike-through markers', () => {
		expect(plainTextExcerpt('a ~~b~~ c')).toBe('a b c');
	});

	it('handles one level of nested parentheses in link targets', () => {
		expect(plainTextExcerpt('see [a](https://x.com/a_(b)) end')).toBe('see a end');
	});

	it('keeps text at exactly maxLength untouched', () => {
		expect(plainTextExcerpt('x'.repeat(50), 50)).toBe('x'.repeat(50));
	});

	it('truncates at maxLength with a trailing ellipsis', () => {
		expect(plainTextExcerpt('x'.repeat(51), 50)).toBe(`${'x'.repeat(50)}…`);
	});

	it('trims the truncated tail before appending the ellipsis', () => {
		expect(plainTextExcerpt('aaa '.repeat(30), 12)).toBe('aaa aaa aaa…');
	});

	it('truncates long CJK text by characters', () => {
		expect(plainTextExcerpt('中'.repeat(200), 50)).toBe(`${'中'.repeat(50)}…`);
	});

	it('uses a default budget of 160 characters', () => {
		expect(plainTextExcerpt('a'.repeat(200))).toBe(`${'a'.repeat(160)}…`);
	});

	it('returns an empty string when only markers remain', () => {
		expect(plainTextExcerpt('```\ncode\n```')).toBe('');
	});
});

describe('firstImageFromMarkdown', () => {
	it('returns the first markdown image URL', () => {
		expect(
			firstImageFromMarkdown('hello ![a](https://x.test/a.png) ![b](https://x.test/b.png)')
		).toBe('https://x.test/a.png');
	});

	it('recognises raw <img> tags', () => {
		expect(firstImageFromMarkdown('<img src="/i/abc">')).toBe('/i/abc');
	});

	it('picks whichever syntax appears first', () => {
		expect(firstImageFromMarkdown('![a](https://x.test/a.png) <img src="/later">')).toBe(
			'https://x.test/a.png'
		);
		expect(firstImageFromMarkdown('<img src="/early"> ![a](https://x.test/a.png)')).toBe('/early');
	});

	it('ignores images inside fenced code blocks', () => {
		expect(
			firstImageFromMarkdown('```md\n![a](https://x.test/a.png)\n```\n![b](https://x.test/b.png)')
		).toBe('https://x.test/b.png');
		expect(firstImageFromMarkdown('```\n![a](https://x.test/a.png)\n```')).toBeNull();
	});

	it('returns null when no image exists', () => {
		expect(firstImageFromMarkdown('no images here')).toBeNull();
		expect(firstImageFromMarkdown('')).toBeNull();
	});

	it('rejects covers outside the site-internal / https policy', () => {
		// Policy (review finding): visitor page loads must not turn into
		// third-party requests, data: payloads or script-ish schemes.
		expect(firstImageFromMarkdown('![x](javascript:alert(1))')).toBeNull();
		expect(firstImageFromMarkdown('![x](//evil.example/p.png)')).toBeNull();
		// '\' folds to '/' for special schemes: '/\host' parses as
		// protocol-relative (review round 2).
		expect(firstImageFromMarkdown('![x](/\\evil.example/a.png)')).toBeNull();
		expect(firstImageFromMarkdown('![x](/\\/evil.example/a.png)')).toBeNull();
		expect(firstImageFromMarkdown('![x](data:image/png;base64,AAA)')).toBeNull();
		expect(firstImageFromMarkdown('![x](ftp://files.example/a.png)')).toBeNull();
		expect(firstImageFromMarkdown('![x](http://plain.example/a.png)')).toBeNull();
		expect(firstImageFromMarkdown('![x](https://cdn.example/a.png)')).toBe(
			'https://cdn.example/a.png'
		);
		expect(firstImageFromMarkdown('![x](/i/abc.png)')).toBe('/i/abc.png');
	});
});

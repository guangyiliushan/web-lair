import { describe, expect, it } from 'vitest';
import { plainTextExcerpt } from './excerpt';

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

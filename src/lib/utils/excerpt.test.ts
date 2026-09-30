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
});

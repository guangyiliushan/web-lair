import { describe, expect, it } from 'vitest';
import {
	MarkdownProtectionError,
	plainTextLength,
	protectMarkdown,
	restoreMarkdown,
	restoreMarkdownPartial,
	validateTranslation
} from './protect';

describe('markdown protection', () => {
	it('round-trips fenced code, inline code, URLs and link targets', () => {
		const source = [
			'# Title',
			'',
			'Use `npm run build` and read https://example.com/docs.',
			'',
			'```ts',
			'const x = 1;',
			'```',
			'',
			'[link](https://example.com/a) and ![img](/i/abc.png)',
			'',
			'@gh:someone'
		].join('\n');
		const protectedDoc = protectMarkdown(source);
		expect(protectedDoc.text).not.toContain('npm run build');
		expect(protectedDoc.text).not.toContain('const x = 1');
		expect(protectedDoc.text).not.toContain('https://example.com/docs');
		const restored = restoreMarkdown(protectedDoc.text, protectedDoc);
		expect(restored).toBe(source);
	});

	it('rejects a dropped placeholder', () => {
		const protectedDoc = protectMarkdown('Use `code` here.');
		expect(() => restoreMarkdown('Use  here.', protectedDoc)).toThrow(MarkdownProtectionError);
	});

	it('restores a partial body without demanding every token yet', () => {
		const protectedDoc = protectMarkdown('Use `npm run build` and read https://example.com/docs.');
		const markers = [...protectedDoc.text.matchAll(/\[\[WL\d+\]\]/g)].map((match) => match[0]);
		// A stream that has only produced the first placeholder so far: the
		// strict restore rejects this, the preview path must not.
		expect(restoreMarkdownPartial(`${markers[0]} と`, protectedDoc)).toBe(
			`${protectedDoc.tokens[0]} と`
		);
		// A placeholder cut in half stays visible until the rest arrives.
		const cut = markers[1].slice(0, -2);
		expect(restoreMarkdownPartial(cut, protectedDoc)).toBe(cut);
	});

	it('accepts a translation that preserves structure and protected spans', () => {
		const source = '# Hello\n\nUse `npm` to read https://example.com.\n\n```js\nconst a = 1;\n```';
		const translated =
			'# Bonjour\n\nUtilisez `npm` pour lire https://example.com.\n\n```js\nconst a = 1;\n```';
		expect(validateTranslation(source, translated)).toEqual({ ok: true });
	});

	it('rejects changed code, headings or added HTML', () => {
		const source = '# Hello\n\n```js\nconst a = 1;\n```';
		expect(validateTranslation(source, '# Bonjour\n\n```js\nconst a = 2;\n```').ok).toBe(false);
		expect(validateTranslation(source, '## Bonjour\n\n```js\nconst a = 1;\n```').ok).toBe(false);
		expect(
			validateTranslation(source, '# Bonjour <script>alert(1)</script>\n\n```js\nconst a = 1;\n```')
				.ok
		).toBe(false);
	});

	it('can skip the length ratio for a chunk-level check', () => {
		// A short CJK chunk rendered in English is legitimately many times
		// longer; the ratio gate only makes sense on the assembled document.
		const source = '短句。';
		const translated = 'A deliberately much longer English rendering of that short line.';
		expect(validateTranslation(source, translated).ok).toBe(false);
		expect(validateTranslation(source, translated, { checkLengthRatio: false })).toEqual({
			ok: true
		});
	});

	it('accepts a script-pair length window', () => {
		const source = '欢迎'.repeat(50); // 100 code points
		const translated = 'Welcome '.repeat(50).trim(); // ~4x, legitimate for zh -> en
		expect(validateTranslation(source, translated).ok).toBe(false);
		expect(validateTranslation(source, translated, { lengthRatio: { min: 1, max: 5 } }).ok).toBe(
			true
		);
	});

	it('measures plain text without code fences', () => {
		expect(plainTextLength('```js\nconst a = 1;\n```')).toBe(0);
		expect(plainTextLength('hello **world**')).toBeGreaterThan(0);
	});
});

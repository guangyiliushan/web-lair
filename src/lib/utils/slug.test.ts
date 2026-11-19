import { describe, expect, it } from 'vitest';
import { normalizeSlug, tagSlug, titleSlug, isValidTagName, TAG_SLUG_RE } from './slug';

describe('normalizeSlug', () => {
	it('lowercases and strips characters outside [a-z0-9-]', () => {
		expect(normalizeSlug('Hello World!')).toBe('helloworld');
	});

	it('collapses repeated hyphens and trims leading/trailing ones', () => {
		expect(normalizeSlug('--my--post--')).toBe('my-post');
	});

	it('drops non-latin characters entirely', () => {
		expect(normalizeSlug('中文标题 Title')).toBe('title');
	});
});

// The tag slug rule is the storage identity of a tag. Tags
// are English-only, so CJK is stripped rather than
// kept: a Chinese tag slug used to be routable, and `UI/UX` used to produce
// `ui/ux`, which splits the `/posts/tags/[slug]` route.
describe('tagSlug', () => {
	it('lowercases and collapses separators to single hyphens', () => {
		expect(tagSlug('Hello World')).toBe('hello-world');
		expect(tagSlug('SVELTE')).toBe('svelte');
		expect(tagSlug('A  B')).toBe('a-b');
	});

	it('drops non-ASCII characters', () => {
		expect(tagSlug('你好 世界')).toBe('');
		expect(tagSlug('演示')).toBe('');
	});

	it('trims and keeps URL-safe punctuation', () => {
		expect(tagSlug(' a b ')).toBe('a-b');
		expect(tagSlug('C++ 11')).toBe('c++-11');
		expect(tagSlug('Node.js')).toBe('node.js');
		expect(tagSlug('UI/UX')).toBe('ui-ux');
	});
});

describe('isValidTagName', () => {
	it('accepts printable ASCII names the DB CHECK allows', () => {
		expect(isValidTagName('design')).toBe(true);
		expect(isValidTagName('C++')).toBe(true);
		expect(isValidTagName('UI/UX')).toBe(true);
		expect(isValidTagName('design thinking')).toBe(true);
	});

	it('rejects CJK, untrimmed and oversized names', () => {
		expect(isValidTagName('日本語')).toBe(false);
		expect(isValidTagName(' design')).toBe(false);
		expect(isValidTagName('a'.repeat(41))).toBe(false);
		expect(isValidTagName('')).toBe(false);
	});

	it('rejects names whose derived slug is not URL-safe', () => {
		// These satisfy TAG_NAME_RE but tagSlug() yields a leading `.`/`_`/`+`
		// or an empty string - exactly the 23514 the DB CHECK would raise.
		expect(tagSlug('.NET')).toBe('.net');
		expect(isValidTagName('.NET')).toBe(false);
		expect(isValidTagName('_draft')).toBe(false);
		expect(isValidTagName('+1')).toBe(false);
		expect(isValidTagName('+++')).toBe(false);
	});

	it('every accepted name yields a DB-valid slug', () => {
		for (const name of ['design', 'C++', 'Node.js', 'UI/UX', 'R&D', '.NET', '_x']) {
			if (isValidTagName(name)) expect(TAG_SLUG_RE.test(tagSlug(name))).toBe(true);
		}
	});
});

// Note title slugs keep CJK on purpose - the three
// slug rules coexist and must not be conflated.
describe('titleSlug', () => {
	it('lowercases, collapses separators and trims the edges', () => {
		expect(titleSlug('Hello World!')).toBe('hello-world');
		expect(titleSlug('A---B   C')).toBe('a-b-c');
		expect(titleSlug('— 前夜 —')).toBe('前夜');
	});

	it('keeps CJK and mixed scripts', () => {
		expect(titleSlug('你好，世界！')).toBe('你好-世界');
		expect(titleSlug('AI 与 未来')).toBe('ai-与-未来');
	});

	it('caps the length and leaves no trailing hyphen after the cut', () => {
		// Hardcode the reviewed cap: importing the constant
		// would keep this green even if the value silently changed.
		expect(titleSlug('a'.repeat(200)).length).toBe(120);
		const cut = titleSlug(`${'a'.repeat(119)} b`);
		expect(cut.endsWith('-')).toBe(false);
	});

	it('yields an empty slug only for pure punctuation', () => {
		expect(titleSlug('!!! ...')).toBe('');
	});
});

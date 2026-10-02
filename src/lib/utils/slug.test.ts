import { describe, expect, it } from 'vitest';
import { normalizeSlug, tagSlug, titleSlug } from './slug';

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

// The tag slug rule is the storage identity of a tag (single-sourced in
// lib/utils since P1.1) - these tests pin its exact legacy behaviour.
describe('tagSlug', () => {
	it('lowercases and collapses whitespace runs to single hyphens', () => {
		expect(tagSlug('Hello World')).toBe('hello-world');
		expect(tagSlug('SVELTE')).toBe('svelte');
		expect(tagSlug('A  B')).toBe('a-b');
	});

	it('keeps CJK and other non-ASCII characters (§9.4)', () => {
		expect(tagSlug('你好 世界')).toBe('你好-世界');
		expect(tagSlug('演示')).toBe('演示');
	});

	it('does not trim or strip punctuation (exact legacy behaviour)', () => {
		expect(tagSlug(' a b ')).toBe('-a-b-');
		expect(tagSlug('C++ 11')).toBe('c++-11');
	});
});

// Note title slugs keep CJK on purpose (notes plan v0.4 §8.3) - the three
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
		// Hardcode the reviewed cap (review finding): importing the constant
		// would keep this green even if the value silently changed.
		expect(titleSlug('a'.repeat(200)).length).toBe(120);
		const cut = titleSlug(`${'a'.repeat(119)} b`);
		expect(cut.endsWith('-')).toBe(false);
	});

	it('yields an empty slug only for pure punctuation', () => {
		expect(titleSlug('!!! ...')).toBe('');
	});
});

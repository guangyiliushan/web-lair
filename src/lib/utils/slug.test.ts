import { describe, expect, it } from 'vitest';
import { normalizeSlug } from './slug';

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

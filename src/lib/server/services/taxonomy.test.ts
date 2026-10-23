import { describe, expect, it } from 'vitest';
import {
	isValidTaxonomySlug,
	parseTaxonomyI18n,
	resolveTaxonomyDescription,
	resolveTaxonomyName,
	taxonomyCompleteness
} from './taxonomy';

const row = (
	overrides: Partial<{ name: string; nameI18n: Record<string, string>; sourceLang: string }> = {}
) => ({
	name: overrides.name ?? '技术笔记',
	nameI18n: overrides.nameI18n ?? { en: 'Tech Notes' },
	sourceLang: overrides.sourceLang ?? 'zh-cn'
});

describe('resolveTaxonomyName', () => {
	it('returns the source label to the source locale', () => {
		expect(resolveTaxonomyName(row(), 'zh-cn')).toBe('技术笔记');
	});

	it('returns the exact translation when present', () => {
		expect(resolveTaxonomyName(row(), 'en')).toBe('Tech Notes');
	});

	it('falls back to English before the source label for a third locale', () => {
		expect(resolveTaxonomyName(row(), 'ja')).toBe('Tech Notes');
	});

	it('never lets en outrank the source for the source reader', () => {
		// The bug this helper exists for: resolveLocalized would return 'Tech
		// Notes' for a zh reader because name_i18n has no zh-cn key.
		expect(resolveTaxonomyName(row({ nameI18n: { en: 'Tech Notes' } }), 'zh-cn')).toBe('技术笔记');
	});

	it('falls back to the source label when the third locale and English are missing', () => {
		expect(resolveTaxonomyName(row({ nameI18n: {} }), 'ja')).toBe('技术笔记');
	});

	it('treats blank translations as missing', () => {
		expect(resolveTaxonomyName(row({ nameI18n: { en: '   ', ja: '' } }), 'ja')).toBe('技术笔记');
	});
});

describe('resolveTaxonomyDescription', () => {
	it('resolves per locale with the same ordering', () => {
		expect(resolveTaxonomyDescription('源描述', { en: 'English description' }, 'zh-cn', 'en')).toBe(
			'English description'
		);
		expect(resolveTaxonomyDescription('源描述', { en: 'English description' }, 'zh-cn', 'ja')).toBe(
			'English description'
		);
		expect(resolveTaxonomyDescription('源描述', {}, 'zh-cn', 'zh-cn')).toBe('源描述');
	});

	it('returns null when the source description is empty', () => {
		expect(resolveTaxonomyDescription('', {}, 'zh-cn', 'en')).toBeNull();
	});
});

describe('parseTaxonomyI18n', () => {
	it('drops the source locale and blank fields', () => {
		const form = new FormData();
		form.set('name_en', 'Tech Notes');
		form.set('name_zh-cn', '技术笔记');
		form.set('name_ja', '   ');
		expect(parseTaxonomyI18n(form, 'name', 'zh-cn')).toEqual({ en: 'Tech Notes' });
	});
});

describe('taxonomyCompleteness', () => {
	it('counts the source plus every non-blank translation', () => {
		expect(taxonomyCompleteness(row())).toBe(2);
		expect(taxonomyCompleteness(row({ nameI18n: { en: 'Tech', ja: 'テック' } }))).toBe(3);
		expect(taxonomyCompleteness(row({ nameI18n: {} }))).toBe(1);
	});
});

describe('isValidTaxonomySlug', () => {
	it('accepts lowercase hyphenated ASCII', () => {
		expect(isValidTaxonomySlug('tech-notes')).toBe(true);
		expect(isValidTaxonomySlug('design')).toBe(true);
	});

	it('rejects uppercase, underscores, CJK and leading hyphens', () => {
		expect(isValidTaxonomySlug('Tech-Notes')).toBe(false);
		expect(isValidTaxonomySlug('tech_notes')).toBe(false);
		expect(isValidTaxonomySlug('技术')).toBe(false);
		expect(isValidTaxonomySlug('-tech')).toBe(false);
	});
});

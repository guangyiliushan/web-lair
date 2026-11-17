import { describe, expect, it } from 'vitest';
import {
	emptyHeroCopy,
	hasHeroOverride,
	renderHeroTokens,
	resolveHeroCopy,
	resolveHeroField,
	type HeroDefaults
} from './home-hero';

/**
 * Resolution contract: requested locale -> site default
 * language -> built-in copy -> empty. Tokens render as plain text; an empty
 * string is "no override", never a blank hero.
 */
const DEFAULTS: HeroDefaults = {
	en: {
		title: 'Hi, I am guangyiliushan',
		subtitlePrefix: 'A SvelteKit Full Stack',
		subtitleHighlight: '<Developer />',
		description: 'Independent developer.',
		welcome: 'Welcome.'
	},
	'zh-cn': {
		title: '你好，我是 guangyiliushan',
		subtitlePrefix: '一名 SvelteKit 全栈',
		subtitleHighlight: '<Developer />',
		description: '独立开发者。',
		welcome: '欢迎。'
	},
	ja: {
		title: 'こんにちは、guangyiliushan です',
		subtitlePrefix: 'SvelteKit フルスタック',
		subtitleHighlight: '<Developer />',
		description: 'インディペンデント開発者。',
		welcome: 'ようこそ。'
	}
};

const TOKENS = { name: 'guangyiliushan', label: 'guang' };

describe('hero copy resolution', () => {
	it('prefers the requested locale override', () => {
		const result = resolveHeroField(
			{ en: 'Custom {name}', 'zh-cn': '自定义' },
			'title',
			'en',
			'zh-cn',
			DEFAULTS,
			TOKENS
		);
		expect(result).toEqual({ value: 'Custom guangyiliushan', source: 'override' });
	});

	it('falls back to the site default language override', () => {
		const result = resolveHeroField(
			{ 'zh-cn': '默认 {label}' },
			'title',
			'en',
			'zh-cn',
			DEFAULTS,
			TOKENS
		);
		expect(result).toEqual({ value: '默认 guang', source: 'site_default' });
	});

	it('falls back to the built-in copy when no override exists', () => {
		const result = resolveHeroField({}, 'title', 'ja', 'en', DEFAULTS, TOKENS);
		expect(result).toEqual({
			value: 'こんにちは、guangyiliushan です',
			source: 'default'
		});
	});

	it('treats an empty string as a removal, not an empty hero', () => {
		const result = resolveHeroField({ en: '   ' }, 'title', 'en', 'en', DEFAULTS, TOKENS);
		expect(result).toEqual({ value: 'Hi, I am guangyiliushan', source: 'default' });
	});

	it('never returns an empty title when defaults exist for the site default only', () => {
		const defaults = { en: DEFAULTS.en } as HeroDefaults;
		const result = resolveHeroField({}, 'title', 'ja', 'en', defaults, TOKENS);
		expect(result).toEqual({ value: DEFAULTS.en.title, source: 'default' });
		expect(result.value).not.toBe('');
	});

	it('resolves all five fields for the homepage read path', () => {
		const copy = emptyHeroCopy();
		copy.title['zh-cn'] = '你好 {name}';
		copy.welcome['zh-cn'] = '{label} 的博客';

		const resolved = resolveHeroCopy(copy, 'zh-cn', 'en', DEFAULTS, TOKENS);

		expect(resolved.title).toBe('你好 guangyiliushan');
		expect(resolved.welcome).toBe('guang 的博客');
		expect(resolved.description).toBe(DEFAULTS['zh-cn'].description);
	});

	it('renders tokens as plain text (no html interpretation)', () => {
		expect(renderHeroTokens('Hi <b>{name}</b>', TOKENS)).toBe('Hi <b>guangyiliushan</b>');
	});

	it('detects whether a locale map carries any override', () => {
		expect(hasHeroOverride({})).toBe(false);
		expect(hasHeroOverride({ en: '', ja: ' ' })).toBe(false);
		expect(hasHeroOverride({ en: 'x' })).toBe(true);
		expect(hasHeroOverride(null)).toBe(false);
	});
});

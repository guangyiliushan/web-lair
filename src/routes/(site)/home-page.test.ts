import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

/**
 * Homepage read path (W4.5): the page resolves `home_hero` for the request
 * locale with the locale -> site default -> built-in chain, renders `{name}`/
 * `{label}` as text, and takes the owner identity + social links from the
 * layout (`parent()`) instead of issuing a second profile read.
 */
const { state } = vi.hoisted(() => ({
	state: {
		home: {
			title: {} as Record<string, string>,
			subtitlePrefix: {},
			subtitleHighlight: {},
			description: {},
			welcome: {},
			updatedAt: null as Date | null,
			updatedBy: null as string | null
		},
		siteDefaultLang: 'en'
	}
}));

vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => state.siteDefaultLang),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/services/owner-profile', () => ({
	loadHomeHero: vi.fn(async () => state.home)
}));

import { load } from './+page.server';

overwriteGetLocale(() => 'en');

function parent(overrides: { name?: string; label?: string | null } = {}) {
	return async () => ({
		siteOwner: {
			name: overrides.name ?? 'guangyiliushan',
			avatar: '',
			headerLabel: overrides.label ?? null
		},
		ownerLinks: [{ platform: 'github', href: 'https://github.com/guang' }]
	});
}

async function run(overrides?: { name?: string; label?: string | null }) {
	return (await load({ parent: parent(overrides) } as never)) as {
		owner: { name: string };
		ownerLinks: { platform: string }[];
		hero: Record<string, string>;
		heroLocale: string;
	};
}

describe('homepage hero read', () => {
	beforeEach(() => {
		state.home = {
			title: {},
			subtitlePrefix: {},
			subtitleHighlight: {},
			description: {},
			welcome: {},
			updatedAt: null,
			updatedBy: null
		};
		state.siteDefaultLang = 'en';
		overwriteGetLocale(() => 'en');
	});

	it('renders the parameterized default title with the current owner name', async () => {
		const data = await run({ name: 'mikoto' });
		expect(data.hero.title).toBe("Hi, I'm mikoto 👋");
		expect(data.heroLocale).toBe('en');
	});

	it('re-renders the default title when the owner name changes (R-3)', async () => {
		const first = await run({ name: 'guangyiliushan' });
		const second = await run({ name: 'luna' });
		expect(first.hero.title).toBe("Hi, I'm guangyiliushan 👋");
		expect(second.hero.title).toBe("Hi, I'm luna 👋");
	});

	it('prefers a locale override and renders {name}/{label} as text', async () => {
		state.home.title = { 'zh-cn': '你好 {name}（{label}）' };
		overwriteGetLocale(() => 'zh-cn');

		const data = await run({ name: 'mikoto', label: 'shan' });

		expect(data.heroLocale).toBe('zh-cn');
		expect(data.hero.title).toBe('你好 mikoto（shan）');
	});

	it('falls back to a site-default-language override', async () => {
		state.siteDefaultLang = 'zh-cn';
		state.home.description = { 'zh-cn': '站点默认描述' };
		overwriteGetLocale(() => 'en');

		const data = await run();

		expect(data.hero.description).toBe('站点默认描述');
	});

	it('passes the owner social links through without a second profile read', async () => {
		const data = await run();
		expect(data.ownerLinks).toEqual([{ platform: 'github', href: 'https://github.com/guang' }]);
	});
});

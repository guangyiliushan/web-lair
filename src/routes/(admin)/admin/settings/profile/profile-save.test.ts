import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the profile form: the owner/pointer gate decides
 * whether the page renders inputs, the action re-checks the role before it
 * touches the service, social rows are parsed into the service shape and
 * typed validation failures surface as 400/409 form errors (never a crash).
 */
const { serviceState, guardMock } = vi.hoisted(() => ({
	serviceState: {
		view: {
			profile: {
				userId: 'owner-1',
				displayName: 'guangyiliushan',
				headerLabel: 'guang' as string | null,
				avatarUrl: null as string | null,
				links: null as { platform: string; href: string }[] | null
			},
			email: 'owner@example.com',
			pointerUserId: 'owner-1' as string | null
		},
		hero: {
			title: {} as Record<string, string>,
			subtitlePrefix: {},
			subtitleHighlight: {},
			description: {},
			welcome: {},
			updatedAt: null as Date | null,
			updatedBy: null as string | null
		},
		saveError: null as Error | null,
		heroError: null as Error | null,
		saved: null as unknown,
		savedHero: null as unknown
	},
	guardMock: vi.fn(async () => {})
}));

vi.mock('$lib/server/authz', () => ({ requireAdminRole: guardMock }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(async () => 'en'),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/services/owner-profile', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/services/owner-profile')>();
	return {
		...actual,
		loadOwnerEditorView: vi.fn(async () => serviceState.view),
		loadHomeHero: vi.fn(async () => serviceState.hero),
		saveOwnerProfile: vi.fn(async (input: unknown, options: unknown) => {
			if (serviceState.saveError) throw serviceState.saveError;
			serviceState.saved = { input, options };
			return {
				userId: 'owner-1',
				displayName: 'guangyiliushan',
				headerLabel: 'shan',
				avatarUrl: null,
				links: null
			};
		}),
		saveHomeHero: vi.fn(async (input: unknown, options: unknown) => {
			if (serviceState.heroError) throw serviceState.heroError;
			serviceState.savedHero = { input, options };
			return input;
		})
	};
});

import { actions, load } from './+page.server';
import { OwnerProfileError } from '$lib/server/services/owner-profile';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

function makeEvent(
	fields: Record<string, string | string[]>,
	role: 'owner' | 'admin' = 'owner',
	userId = 'owner-1'
) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
	}
	return {
		request: new Request('http://x/admin/settings/profile?/save', {
			method: 'POST',
			body
		}),
		locals: { user: { id: userId }, admin: { userId, role } }
	};
}

function callSave(event: ReturnType<typeof makeEvent>) {
	return (actions as unknown as Record<string, (event: never) => Promise<unknown>>)['save'](
		event as never
	);
}

function callHeroSave(event: ReturnType<typeof makeEvent>) {
	return (actions as unknown as Record<string, (event: never) => Promise<unknown>>)['saveHero'](
		event as never
	);
}

describe('profile settings route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serviceState.saveError = null;
		serviceState.heroError = null;
		serviceState.saved = null;
		serviceState.savedHero = null;
		serviceState.view.pointerUserId = 'owner-1';
		serviceState.view.profile.headerLabel = 'guang';
	});

	it('marks the page editable only for the pointer owner', async () => {
		await expect(load(makeEvent({}) as never)).resolves.toMatchObject({ editable: true });

		serviceState.view.pointerUserId = 'someone-else';
		await expect(load(makeEvent({}) as never)).resolves.toMatchObject({ editable: false });

		serviceState.view.pointerUserId = 'owner-1';
		await expect(load(makeEvent({}, 'admin', 'admin-1') as never)).resolves.toMatchObject({
			editable: false
		});
	});

	it('re-checks the admin guard and owner tier before saving', async () => {
		await expect(
			callSave(
				makeEvent(
					{
						displayName: 'guangyiliushan',
						headerLabel: 'guang',
						avatarUrl: '',
						linkPlatform: '',
						linkHref: ''
					},
					'admin',
					'admin-1'
				)
			)
		).rejects.toMatchObject({ status: 403 });
		expect(guardMock).toHaveBeenCalled();
		expect(serviceState.saved).toBeNull();
	});

	it('parses display name, label, avatar and ordered social rows', async () => {
		const result = await callSave(
			makeEvent({
				displayName: 'guangyiliushan',
				headerLabel: 'shan',
				avatarUrl: 'https://example.com/a.png',
				linkPlatform: ['github', 'email', ''],
				linkHref: ['https://github.com/guang', 'mailto:me@example.com', ''],
				linkLabel: ['', '', '']
			})
		);

		expect(result).toMatchObject({ step: 'profile', ok: true });
		expect(serviceState.saved).toEqual({
			input: {
				displayName: 'guangyiliushan',
				headerLabel: 'shan',
				avatarUrl: 'https://example.com/a.png',
				links: [
					{ platform: 'github', href: 'https://github.com/guang' },
					{ platform: 'email', href: 'mailto:me@example.com' }
				]
			},
			options: { actorId: 'owner-1' }
		});
	});

	it('surfaces typed validation failures as form errors', async () => {
		serviceState.saveError = new OwnerProfileError(
			'header_label_invalid',
			'Header label must be 1-6 characters.',
			400
		);

		const result = await callSave(makeEvent({ displayName: 'x', headerLabel: 'abcdefg' }));

		expect(result).toMatchObject({
			status: 400,
			data: { step: 'profile', ok: false, message: 'Header label must be 1-6 characters.' }
		});
	});

	it('maps pointer mismatches to 409', async () => {
		serviceState.saveError = new OwnerProfileError(
			'owner_pointer_mismatch',
			'This profile belongs to a different owner.',
			409
		);

		const result = await callSave(makeEvent({ displayName: 'x' }));

		expect(result).toMatchObject({ status: 409, data: { step: 'profile', ok: false } });
	});

	it('exposes per-locale hero defaults and raw overrides to the editor', async () => {
		serviceState.hero.title = { 'zh-cn': '你好 {name}' };

		const result = (await load(makeEvent({}) as never)) as {
			hero: {
				locales: string[];
				siteDefaultLang: string;
				copy: { title: Record<string, string> };
				defaults: Record<string, Record<string, string>>;
			};
		};

		expect(result.hero.locales).toEqual(['en', 'zh-cn', 'ja']);
		expect(result.hero.siteDefaultLang).toBe('en');
		expect(result.hero.copy.title).toEqual({ 'zh-cn': '你好 {name}' });
		expect(typeof result.hero.defaults.en.title).toBe('string');
	});

	it('saves every hero field per locale and keeps empty strings as removals', async () => {
		const result = await callHeroSave(
			makeEvent({
				'hero.title.en': 'Hi, I am {name}',
				'hero.title.zh-cn': '',
				'hero.title.ja': 'こんにちは',
				'hero.subtitlePrefix.en': 'A SvelteKit',
				'hero.description.en': 'Line one',
				'hero.welcome.ja': '{label} のサイトへ'
			})
		);

		expect(result).toMatchObject({ step: 'hero', ok: true });
		expect(serviceState.savedHero).toEqual({
			input: {
				title: { en: 'Hi, I am {name}', 'zh-cn': '', ja: 'こんにちは' },
				subtitlePrefix: { en: 'A SvelteKit' },
				subtitleHighlight: {},
				description: { en: 'Line one' },
				welcome: { ja: '{label} のサイトへ' }
			},
			options: { actorId: 'owner-1' }
		});
	});

	it('rejects hero writes for a non-owner admin', async () => {
		await expect(
			callHeroSave(makeEvent({ 'hero.title.en': 'x' }, 'admin', 'admin-1'))
		).rejects.toMatchObject({ status: 403 });
		expect(serviceState.savedHero).toBeNull();
	});

	it('surfaces hero validation failures as 400 form errors', async () => {
		serviceState.heroError = new OwnerProfileError('hero_invalid', 'title.en is too long.', 400);

		const result = await callHeroSave(makeEvent({ 'hero.title.en': 'x'.repeat(121) }));

		expect(result).toMatchObject({
			status: 400,
			data: { step: 'hero', ok: false, message: 'title.en is too long.' }
		});
	});
});

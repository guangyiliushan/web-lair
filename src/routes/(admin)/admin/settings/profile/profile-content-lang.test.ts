import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Content language moved from Account to Profile & Preferences.
 * The load exposes the stored preference next to the site default; the
 * `contentLang` action validates against the site languages, writes ONLY
 * `user.default_lang` for the signed-in row, and stores `null` for "follow
 * site default". Account no longer owns this section (its route test is gone).
 */
const { state, dbMock, guardMock, getOptionMock } = vi.hoisted(() => {
	const state = {
		updates: [] as { table: unknown; values: Record<string, unknown>; where: unknown }[],
		userRow: { defaultLang: null as string | null }
	};
	const dbMock = {
		query: { user: { findFirst: vi.fn(async () => state.userRow) } },
		update: vi.fn((table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async (where: unknown) => {
					state.updates.push({ table, values, where });
				}
			})
		}))
	};
	return {
		state,
		dbMock,
		guardMock: vi.fn(async () => {}),
		getOptionMock: vi.fn(async () => 'en')
	};
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: guardMock }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: getOptionMock,
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/services/owner-profile', () => ({
	loadOwnerEditorView: vi.fn(async () => ({
		profile: {
			userId: 'owner-1',
			displayName: 'Owner',
			headerLabel: null,
			avatarUrl: null,
			links: null
		},
		email: 'owner@example.com',
		pointerUserId: 'owner-1'
	})),
	loadHomeHero: vi.fn(async () => ({
		title: {},
		subtitlePrefix: {},
		subtitleHighlight: {},
		description: {},
		welcome: {},
		updatedAt: null,
		updatedBy: null
	})),
	saveOwnerProfile: vi.fn(),
	saveHomeHero: vi.fn(),
	OwnerProfileError: class extends Error {}
}));

import { actions, load } from './+page.server';
import { user as userTable } from '$lib/server/db/auth.schema';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

function makeEvent(fields: Record<string, string>, role: 'owner' | 'admin' = 'owner') {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/settings/profile?/contentLang', {
			method: 'POST',
			body
		}),
		locals: { user: { id: 'user-1' }, admin: { userId: 'user-1', role } }
	};
}

function callContentLang(fields: Record<string, string>, role: 'owner' | 'admin' = 'owner') {
	const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[
		'contentLang'
	];
	return fn(makeEvent(fields, role) as never);
}

function sqlOf(cond: unknown): string {
	return new PgDialect().sqlToQuery(cond as SQL).sql.toLowerCase();
}

describe('profile content language', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.updates = [];
		state.userRow = { defaultLang: null };
		getOptionMock.mockResolvedValue('en');
	});

	it('load exposes the stored language, site default, languages and hero data', async () => {
		state.userRow = { defaultLang: 'ja' };
		getOptionMock.mockResolvedValue('zh-cn');

		const result = (await load(makeEvent({}) as never)) as {
			defaultLang: string | null;
			siteDefaultLang: string;
			langs: string[];
			hero: { locales: string[] };
		};

		expect(result.defaultLang).toBe('ja');
		expect(result.siteDefaultLang).toBe('zh-cn');
		expect(result.langs).toEqual(['en', 'zh-cn', 'ja']);
		expect(result.hero.locales).toEqual(['en', 'zh-cn', 'ja']);
	});

	it('runs behind the admin guard before touching the database', async () => {
		await callContentLang({ lang: 'zh-cn' });

		expect(guardMock).toHaveBeenCalledTimes(1);
		expect(guardMock.mock.invocationCallOrder[0]).toBeLessThan(
			dbMock.update.mock.invocationCallOrder[0]
		);
	});

	it('rejects a language outside the site set without writing', async () => {
		const result = await callContentLang({ lang: 'fr' });

		expect(result).toMatchObject({
			status: 400,
			data: { message: '该语言不可用', step: 'contentLang', ok: false }
		});
		expect(state.updates).toHaveLength(0);
	});

	it('rejects a non-owner admin (profile tier is owner-only)', async () => {
		await expect(callContentLang({ lang: 'zh-cn' }, 'admin')).rejects.toMatchObject({
			status: 403
		});
		expect(state.updates).toHaveLength(0);
	});

	it('stores the chosen language on the signed-in user row only', async () => {
		const result = await callContentLang({ lang: 'zh-cn' });

		expect(result).toMatchObject({
			message: '内容默认语言已保存',
			step: 'contentLang',
			ok: true
		});
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].table).toBe(userTable);
		expect(state.updates[0].values).toEqual({ defaultLang: 'zh-cn' });
		const rendered = sqlOf(state.updates[0].where);
		expect(rendered).toContain('"user"."id"');
	});

	it('maps follow-site-default to NULL', async () => {
		await callContentLang({ lang: '' });
		expect(state.updates[0].values).toEqual({ defaultLang: null });
	});
});

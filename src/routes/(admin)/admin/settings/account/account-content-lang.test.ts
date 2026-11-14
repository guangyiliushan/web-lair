import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Route-level tests for the account content-language setting (post-creation
 * flow, task A4): the load exposes the stored preference next to the site
 * default, and the `contentLang` action validates against the site languages,
 * writes ONLY `user.default_lang` for the signed-in row and stores `null` for
 * "follow site default". The db module is mocked; the registry's language
 * list stays the real one through the mocked module below.
 */
const { state, dbMock, guardMock, getOptionMock } = vi.hoisted(() => {
	const state = {
		updates: [] as { table: unknown; values: Record<string, unknown>; where: unknown }[],
		userRow: { twoFactorEnabled: false, defaultLang: null as string | null }
	};
	const dbMock = {
		query: { user: { findFirst: vi.fn(async () => state.userRow) } },
		select: vi.fn(() => {
			const chain = {
				from: () => chain,
				where: () => chain,
				orderBy: () => chain,
				limit: async () => [],
				// Passkey/session queries end on `where` (awaited directly).
				then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve)
			};
			return chain;
		}),
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
vi.mock('$lib/server/auth', () => ({ auth: { api: {} } }));
vi.mock('$lib/server/auth/sessions', () => ({
	pruneOtherSessions: vi.fn(),
	pruneOtherSessionsKeepingNewest: vi.fn()
}));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: guardMock }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: getOptionMock,
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));

import { actions, load } from './+page.server';
import { user as userTable } from '$lib/server/db/auth.schema';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Action copy comes from the message catalog; pin the locale so assertions
// stay in sync with the zh-cn catalog (same convention as the neighbouring
// route tests).
overwriteGetLocale(() => 'zh-cn');

function makeEvent(fields: Record<string, string>, userId: string | null = 'user-1') {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request('http://x/admin/settings/account?/contentLang', {
			method: 'POST',
			body
		}),
		url: new URL('http://x/admin/settings/account'),
		locals: {
			user: userId === null ? null : { id: userId },
			session: userId === null ? null : { id: 'session-1' },
			admin: userId === null ? null : { userId, role: 'owner' as const }
		}
	};
}

function callContentLang(fields: Record<string, string>, userId: string | null = 'user-1') {
	const fn = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[
		'contentLang'
	];
	return fn(makeEvent(fields, userId) as never);
}

/** Rendered SQL of a recorded where-condition (lowercased for contains). */
function sqlOf(cond: unknown): string {
	return new PgDialect().sqlToQuery(cond as SQL).sql.toLowerCase();
}

describe('account content language', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.updates = [];
		state.userRow = { twoFactorEnabled: false, defaultLang: null };
		getOptionMock.mockResolvedValue('en');
	});

	it('load exposes the stored language, the site default and the selectable languages', async () => {
		state.userRow = { twoFactorEnabled: true, defaultLang: 'ja' };
		getOptionMock.mockResolvedValue('zh-cn');

		const result = await load(makeEvent({}) as never);

		expect(result).toMatchObject({
			twoFactorEnabled: true,
			defaultLang: 'ja',
			siteDefaultLang: 'zh-cn',
			langs: ['en', 'zh-cn', 'ja'],
			editable: true,
			hasPassword: false,
			currentSessionId: 'session-1',
			sessions: [],
			passkeys: [],
			oauth: {
				github: { configured: false, callback: 'http://x/api/auth/callback/github' },
				google: { configured: false, callback: 'http://x/api/auth/callback/google' }
			}
		});
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
			data: { message: '该语言不可用', step: 'contentLang' }
		});
		expect(state.updates).toHaveLength(0);
	});

	it('stores the chosen language on the user row only', async () => {
		const result = await callContentLang({ lang: 'zh-cn' });

		expect(result).toMatchObject({ message: '内容默认语言已保存', step: 'contentLang' });
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].table).toBe(userTable);
		expect(state.updates[0].values).toEqual({ defaultLang: 'zh-cn' });
		expect(sqlOf(state.updates[0].where)).toContain('"user"."id"');
	});

	it('maps the follow-site-default choice to null', async () => {
		const result = await callContentLang({ lang: '' });

		expect(result).toMatchObject({ message: '内容默认语言已保存', step: 'contentLang' });
		expect(state.updates[0].values).toEqual({ defaultLang: null });
	});

	it('treats a missing field as follow-site-default', async () => {
		await callContentLang({});

		expect(state.updates[0].values).toEqual({ defaultLang: null });
	});

	it('writes against the signed-in user id', async () => {
		await callContentLang({ lang: 'en' }, 'user-42');

		const rendered = sqlOf(state.updates[0].where);
		const params = new PgDialect().sqlToQuery(state.updates[0].where as SQL).params;
		expect(rendered).toContain('"user"."id"');
		expect(params).toContain('user-42');
	});
});

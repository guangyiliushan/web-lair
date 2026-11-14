import { beforeEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Pin the locale so the assertions stay in sync with the zh-cn catalog.
overwriteGetLocale(() => 'zh-cn');

/**
 * Route-level tests for the Site page actions (W5.2/W5.4). The registry is
 * imported for real so `validateOption` / `OptionWriteError` keep their
 * production behaviour; only the two database-touching entry points are
 * swapped. The db transaction is a fake so the paired-write invariant and the
 * audit call path are observable without PostgreSQL.
 */
const { optionState, writes, auditCalls, txState, authzMock, setBehaviour } = vi.hoisted(() => {
	const state = {
		'site.info': { name: 'Web Lair', description: '', avatar: '' },
		'site.icon': { url: '', version: 4 },
		'site.languages': { enabled: ['en', 'zh-cn', 'ja'] },
		'site.default_lang': 'en',
		'site.timezone': 'UTC'
	} as Record<string, unknown>;
	const writes: { key: string; value: unknown; tx: unknown }[] = [];
	return {
		optionState: state,
		writes,
		auditCalls: [] as { tx: unknown; input: Record<string, unknown> }[],
		txState: {
			opened: 0,
			tx: { insert: vi.fn(), select: vi.fn(), execute: vi.fn() } as unknown
		},
		authzMock: { requireAdminRole: vi.fn(async () => {}) },
		setBehaviour: {
			impl: (async (key: string, value: unknown, tx?: unknown) => {
				writes.push({ key, value, tx });
			}) as (key: string, value: unknown, tx?: unknown) => Promise<void>
		}
	};
});

vi.mock('$lib/server/authz', () => authzMock);
vi.mock('$lib/server/db', () => ({
	db: {
		transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
			txState.opened += 1;
			return callback(txState.tx);
		}
	}
}));
vi.mock('$lib/server/audit', () => ({
	recordActivity: async (tx: unknown, input: Record<string, unknown>) => {
		auditCalls.push({ tx, input });
	}
}));
vi.mock('$lib/server/config/options-registry', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/config/options-registry')>();
	return {
		...actual,
		getOption: async (key: string) => optionState[key],
		setOption: async (key: string, value: unknown, tx?: unknown) =>
			setBehaviour.impl(key, value, tx)
	};
});

import { actions } from './+page.server';

type ActionResult = { status?: number; data?: { message?: string; error?: boolean; op?: string } };

async function run(
	action: 'saveInfo' | 'saveIcon' | 'saveTimezone' | 'saveLanguages',
	fields: Record<string, string | string[]>,
	role: 'owner' | 'admin' | null = 'owner'
): Promise<ActionResult> {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const entry of Array.isArray(value) ? value : [value]) form.append(key, entry);
	}
	const handler = (actions as unknown as Record<string, (event: never) => Promise<unknown>>)[
		action
	];
	return (await handler({
		request: new Request('http://localhost/admin/settings/site', { method: 'POST', body: form }),
		locals: { admin: role ? { role } : undefined, user: { id: 'owner-1' } }
	} as never)) as ActionResult;
}

describe('Site actions (W5.2)', () => {
	beforeEach(() => {
		optionState['site.info'] = { name: 'Web Lair', description: '', avatar: '' };
		optionState['site.icon'] = { url: '', version: 4 };
		optionState['site.timezone'] = 'UTC';
		writes.length = 0;
		auditCalls.length = 0;
		txState.opened = 0;
		authzMock.requireAdminRole.mockClear();
		setBehaviour.impl = async (key, value, tx) => {
			writes.push({ key, value, tx });
		};
	});

	it('saves the trimmed site identity, audits site.update and writes inside one transaction', async () => {
		const result = await run('saveInfo', {
			name: '  Example Site  ',
			description: ' A blurb. ',
			avatar: 'https://cdn.example/a.png'
		});

		expect(result.data?.error).toBeUndefined();
		expect(writes).toEqual([
			{
				key: 'site.info',
				value: {
					name: 'Example Site',
					description: 'A blurb.',
					avatar: 'https://cdn.example/a.png'
				},
				tx: txState.tx
			}
		]);
		expect(auditCalls).toHaveLength(1);
		expect(auditCalls[0].tx).toBe(txState.tx);
		expect(auditCalls[0].input).toMatchObject({
			event: 'site.update',
			actorId: 'owner-1',
			payload: { fields: ['info'] }
		});
		expect(txState.opened).toBe(1);
	});

	it('rejects an empty name / long description / non-https avatar before any write', async () => {
		const empty = await run('saveInfo', { name: '   ', description: '', avatar: '' });
		expect(empty.status).toBe(400);
		expect(empty.data?.message).toContain('站点名称');

		const long = await run('saveInfo', {
			name: 'Site',
			description: 'd'.repeat(301),
			avatar: ''
		});
		expect(long.status).toBe(400);

		const multiline = await run('saveInfo', {
			name: 'Site',
			description: 'two\nlines',
			avatar: ''
		});
		expect(multiline.status).toBe(400);

		const httpAvatar = await run('saveInfo', {
			name: 'Site',
			description: '',
			avatar: 'http://example.com/a.png'
		});
		expect(httpAvatar.status).toBe(400);

		expect(writes).toHaveLength(0);
		expect(auditCalls).toHaveLength(0);
	});

	it('bumps the favicon version on every save so the ?v= cache bust changes', async () => {
		const result = await run('saveIcon', { url: 'https://cdn.example/favicon.svg' });

		expect(result.data?.error).toBeUndefined();
		expect(writes).toEqual([
			{
				key: 'site.icon',
				value: { url: 'https://cdn.example/favicon.svg', version: 5 },
				tx: txState.tx
			}
		]);
		expect(auditCalls[0].input).toMatchObject({
			event: 'site.update',
			payload: { fields: ['icon'] }
		});

		// Unchanged URL: the version still moves - the page's "Refresh icon
		// version" button posts exactly this to bust a same-address file swap.
		optionState['site.icon'] = { url: 'https://cdn.example/favicon.svg', version: 5 };
		await run('saveIcon', { url: 'https://cdn.example/favicon.svg' });
		expect(writes[1]).toMatchObject({
			value: { url: 'https://cdn.example/favicon.svg', version: 6 }
		});

		// The same-origin /i/ proxy goes through the same action path.
		optionState['site.icon'] = { url: '', version: 0 };
		await run('saveIcon', { url: '/i/favicon.ico' });
		expect(writes[2]).toMatchObject({ value: { url: '/i/favicon.ico', version: 1 } });
	});

	it('rejects a javascript:/data:/http favicon and keeps the stored value', async () => {
		for (const url of ['javascript:alert(1)', 'data:image/svg+xml,AAAA', 'http://x/a.ico']) {
			const result = await run('saveIcon', { url });
			expect(result.status).toBe(400);
		}
		expect(writes).toHaveLength(0);
	});

	it('saves a valid IANA zone', async () => {
		const result = await run('saveTimezone', { tz: ' Asia/Taipei ' });

		expect(result.data?.error).toBeUndefined();
		expect(writes).toEqual([{ key: 'site.timezone', value: 'Asia/Taipei', tx: txState.tx }]);
		expect(auditCalls[0].input).toMatchObject({
			event: 'site.update',
			payload: { fields: ['timezone'] }
		});
	});

	it('rejects an invalid IANA zone with a 400 and no write', async () => {
		const result = await run('saveTimezone', { tz: 'Not/AZone' });
		expect(result.status).toBe(400);
		expect(result.data?.message).toContain('IANA');
		expect(writes).toHaveLength(0);
	});

	it('maps the PostgreSQL zone rejection (OptionWriteError) to a 400, not a 500', async () => {
		// The real registry throws OptionWriteError for names Intl accepts but
		// PostgreSQL rejects; simulate it at the setOption seam.
		const registry = await import('$lib/server/config/options-registry');
		setBehaviour.impl = async () => {
			throw new registry.OptionWriteError('时区 "Japan" 不被 PostgreSQL 接受');
		};
		const result = await run('saveTimezone', { tz: 'Japan' });
		expect(result.status).toBe(400);
		expect(result.data?.message).toContain('PostgreSQL');
		expect(writes).toHaveLength(0);
	});

	it('re-checks the role in every action: a non-owner session cannot write admin-tier fields', async () => {
		await expect(
			run('saveInfo', { name: 'X', description: '', avatar: '' }, null)
		).rejects.toMatchObject({ status: 403 });
		await expect(run('saveIcon', { url: '' }, null)).rejects.toMatchObject({ status: 403 });
		await expect(run('saveTimezone', { tz: 'UTC' }, null)).rejects.toMatchObject({ status: 403 });
		expect(writes).toHaveLength(0);
		expect(auditCalls).toHaveLength(0);
	});

	it('allows an admin (not owner) to save identity, icon and time zone', async () => {
		const info = await run('saveInfo', { name: 'Site', description: '', avatar: '' }, 'admin');
		const icon = await run('saveIcon', { url: '' }, 'admin');
		const timezone = await run('saveTimezone', { tz: 'UTC' }, 'admin');
		expect(info.data?.error).toBeUndefined();
		expect(icon.data?.error).toBeUndefined();
		expect(timezone.data?.error).toBeUndefined();
		expect(writes.map((write) => write.key)).toEqual(['site.info', 'site.icon', 'site.timezone']);
	});

	it('writes the language pair in ONE transaction, in canonical order (S7/W5.4)', async () => {
		const result = await run('saveLanguages', {
			enabled: ['ja', 'en'],
			default: 'ja'
		});

		expect(result.data?.error).toBeUndefined();
		expect(txState.opened).toBe(1);
		expect(writes).toEqual([
			{ key: 'site.languages', value: { enabled: ['en', 'ja'] }, tx: txState.tx },
			{ key: 'site.default_lang', value: 'ja', tx: txState.tx }
		]);
		expect(auditCalls).toHaveLength(1);
		expect(auditCalls[0].tx).toBe(txState.tx);
		expect(auditCalls[0].input).toMatchObject({
			event: 'site.update',
			payload: { fields: ['languages', 'default_lang'] }
		});
	});

	it('refuses a default language outside the enabled set before writing anything', async () => {
		const result = await run('saveLanguages', { enabled: ['en'], default: 'ja' });
		expect(result.status).toBe(400);
		expect(result.data?.message).toContain('默认语言');
		expect(writes).toHaveLength(0);
		expect(txState.opened).toBe(0);
	});

	it('refuses an empty or duplicated enabled set (registry schema)', async () => {
		const empty = await run('saveLanguages', { enabled: [], default: 'en' });
		expect(empty.status).toBe(400);
		expect(empty.data?.message).toContain('至少保留一种语言');

		const duplicate = await run('saveLanguages', {
			enabled: ['en', 'en'],
			default: 'en'
		});
		expect(duplicate.status).toBe(400);
		expect(duplicate.data?.message).toContain('只能启用一次');

		expect(writes).toHaveLength(0);
	});

	it('is owner-only: an admin session is refused before parsing the form', async () => {
		await expect(
			run('saveLanguages', { enabled: ['en'], default: 'en' }, 'admin')
		).rejects.toMatchObject({ status: 403 });
		expect(writes).toHaveLength(0);
		expect(txState.opened).toBe(0);
	});
});

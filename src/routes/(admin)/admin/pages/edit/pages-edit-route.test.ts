import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the P2 page editor (T6 unit side): load addressing,
 * the save guards (uuid / empty title / icon whitelist / external URL /
 * reserved and default-row slug rules), the trimmed jsonb payload and the
 * 23505 → 409 conflict mapping. The db module is mocked with a recording
 * chain.
 */
const { dbMock, state, service } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		returningQueue: [] as unknown[][],
		setCalls: [] as Record<string, unknown>[],
		nextThrow: null as unknown
	},
	service: { requireAdminRole: vi.fn() }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: service.requireAdminRole }));

import { actions, load } from './+page.server';

const PAGE_ID = '11111111-1111-1111-1111-111111111111';

function formEvent(entries: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(entries)) body.set(key, value);
	return { request: new Request('http://localhost/admin/pages/edit', { method: 'POST', body }) };
}

function selectChain(): Record<string, unknown> {
	const c: Record<string, unknown> = {};
	const ret = () => c;
	Object.assign(c, {
		from: ret,
		where: ret,
		limit: ret,
		then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
			Promise.resolve(state.selectQueue.shift() ?? []).then(res, rej)
	});
	return c;
}

const baseRow = { id: PAGE_ID, slug: 'about', isDefault: false };

describe('admin page editor (P2)', () => {
	beforeEach(() => {
		state.selectQueue = [];
		state.returningQueue = [];
		state.setCalls = [];
		state.nextThrow = null;
		service.requireAdminRole.mockClear();
		Object.assign(dbMock, {
			select: vi.fn(() => selectChain()),
			update: vi.fn(() => ({
				set: vi.fn((values: Record<string, unknown>) => {
					state.setCalls.push(values);
					return {
						where: vi.fn(() => ({
							returning: vi.fn(async () => {
								if (state.nextThrow) {
									const thrown = state.nextThrow;
									state.nextThrow = null;
									throw thrown;
								}
								return state.returningQueue.shift() ?? [];
							})
						}))
					};
				})
			}))
		});
	});

	it('404s malformed ids before touching the database', async () => {
		await expect(
			load({ url: new URL('http://localhost/admin/pages/edit?id=nope') } as never)
		).rejects.toMatchObject({ status: 404 });
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('loads a row for editing and 404s unknown ids', async () => {
		state.selectQueue = [
			[
				{
					id: PAGE_ID,
					slug: 'about',
					title: { en: 'About Me' },
					description: null,
					icon: null,
					externalUrl: null,
					isDefault: true,
					content: { en: 'x' },
					updatedAt: new Date('2026-10-01T00:00:00Z')
				}
			]
		];
		const data = (await load({
			url: new URL(`http://localhost/admin/pages/edit?id=${PAGE_ID}`)
		} as never)) as {
			page: { slug: string; isDefault: boolean; hasContent: boolean; description: unknown };
		};
		expect(service.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(data.page.slug).toBe('about');
		expect(data.page.isDefault).toBe(true);
		expect(data.page.hasContent).toBe(true);
		expect(data.page.description).toEqual({});

		state.selectQueue = [[]];
		await expect(
			load({ url: new URL(`http://localhost/admin/pages/edit?id=${PAGE_ID}`) } as never)
		).rejects.toMatchObject({ status: 404 });
	});

	it('validates the save payload before touching the row', async () => {
		// malformed id
		expect(await actions.save!(formEvent({ id: 'nope' }) as never)).toMatchObject({
			status: 400
		});

		// missing row
		state.selectQueue = [[]];
		expect(await actions.save!(formEvent({ id: PAGE_ID }) as never)).toMatchObject({
			status: 404
		});

		// all-empty title
		state.selectQueue = [[baseRow]];
		expect(
			await actions.save!(
				formEvent({
					id: PAGE_ID,
					title_en: '  ',
					'title_zh-cn': '',
					title_ja: '',
					slug: 'about'
				}) as never
			)
		).toMatchObject({ status: 400 });

		// icon not whitelisted
		state.selectQueue = [[baseRow]];
		expect(
			await actions.save!(
				formEvent({ id: PAGE_ID, title_en: 'X', icon: 'evil', slug: 'about' }) as never
			)
		).toMatchObject({ status: 400 });

		// bad external URL
		state.selectQueue = [[baseRow]];
		expect(
			await actions.save!(
				formEvent({ id: PAGE_ID, title_en: 'X', externalUrl: 'ftp://x', slug: 'about' }) as never
			)
		).toMatchObject({ status: 400 });

		// reserved slug on change
		state.selectQueue = [[baseRow]];
		expect(
			await actions.save!(formEvent({ id: PAGE_ID, title_en: 'X', slug: 'admin' }) as never)
		).toMatchObject({ status: 400 });

		// default-row slug change refused
		state.selectQueue = [[{ ...baseRow, isDefault: true }]];
		expect(
			await actions.save!(formEvent({ id: PAGE_ID, title_en: 'X', slug: 'about-next' }) as never)
		).toMatchObject({ status: 400 });
	});

	it('saves trimmed jsonb and maps duplicate slug to 409', async () => {
		state.selectQueue = [[{ ...baseRow, isDefault: true }]];
		state.returningQueue = [[{ id: PAGE_ID }]];

		const ok = await actions.save!(
			formEvent({
				id: PAGE_ID,
				title_en: ' About Me ',
				'title_zh-cn': '',
				title_ja: ' アバウト ',
				description_en: ' D ',
				description_ja: '',
				icon: '',
				externalUrl: '',
				slug: 'about'
			}) as never
		);
		expect(ok).toEqual({ success: true });
		expect(service.requireAdminRole).toHaveBeenCalled();
		expect(state.setCalls[0]).toEqual({
			title: { en: 'About Me', ja: 'アバウト' },
			description: { en: 'D' },
			icon: null,
			externalUrl: null,
			slug: 'about'
		});

		state.selectQueue = [[baseRow]];
		state.nextThrow = Object.assign(new Error('duplicate key'), {
			cause: { code: '23505' }
		});
		expect(
			await actions.save!(formEvent({ id: PAGE_ID, title_en: 'X', slug: 'solo' }) as never)
		).toMatchObject({ status: 409 });

		state.selectQueue = [[baseRow]];
		state.returningQueue = [[]];
		expect(
			await actions.save!(formEvent({ id: PAGE_ID, title_en: 'X', slug: 'about' }) as never)
		).toMatchObject({ status: 404 });
	});

	it('accepts any single content language and rethrows non-conflict errors', async () => {
		// zh-cn alone is a valid title; en is not required.
		state.selectQueue = [[{ ...baseRow, isDefault: true }]];
		state.returningQueue = [[{ id: PAGE_ID }]];

		const ok = await actions.save!(
			formEvent({ id: PAGE_ID, 'title_zh-cn': '仅中文标题', slug: 'about' }) as never
		);

		expect(ok).toEqual({ success: true });
		expect(state.setCalls[0]).toMatchObject({ title: { 'zh-cn': '仅中文标题' } });

		// A non-unique-violation error bubbles instead of mapping to 409.
		state.selectQueue = [[baseRow]];
		state.nextThrow = new Error('boom');
		await expect(
			actions.save!(formEvent({ id: PAGE_ID, title_en: 'X', slug: 'about' }) as never)
		).rejects.toThrow('boom');
	});
});

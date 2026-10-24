import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the admin tag actions.
 *
 * Tags differ from categories in two ways the actions encode:
 *   · the relation to posts is M:N (`post_tags`), so "remove tag" only drops an
 *     association and never touches the post;
 *   · there is no fallback bucket: `post_tags.tag_id` cascades, so a tag that
 *     still has posts can be deleted in one step.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		inserted: [] as unknown[],
		deleted: 0,
		updated: 0,
		lastSet: undefined as Record<string, unknown> | undefined
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/authz', () => ({ requireAdminRole: vi.fn(async () => {}) }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { requireAdminRole } from '$lib/server/authz';
import { actions as listActions } from './+page.server';
import { actions as recordActions, load as loadRecord } from './[id]/+page.server';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

const guardMock = vi.mocked(requireAdminRole);

const TAG_ID = '11111111-1111-1111-1111-111111111111';
const POST_A = '22222222-2222-2222-2222-222222222222';
const POST_B = '33333333-3333-3333-3333-333333333333';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return () => self;
			}
		}
	);
	return self;
}

function makeEvent(fields: Record<string, string | string[]>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) for (const v of value) body.append(key, v);
		else body.set(key, value);
	}
	return { request: new Request('http://x/admin/posts/tags', { method: 'POST', body }) };
}

type ActionSource = Record<string, (event: never) => Promise<unknown>>;

async function callAction(
	source: ActionSource,
	name: string,
	fields: Record<string, string | string[]> = {},
	id = TAG_ID
) {
	try {
		const fn = source[name];
		const event = { ...makeEvent(fields), params: { id } };
		const result = await fn(event as never);
		return { result: result as Record<string, unknown> | undefined, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown: thrown as { status?: number; location?: string } };
	}
}

function resetDb() {
	state.selectQueue = [];
	Object.assign(dbMock, {
		select: vi.fn(() => makeChain(state.selectQueue.shift() ?? [])),
		insert: vi.fn(() => ({
			values: () => ({ onConflictDoNothing: async () => undefined })
		})),
		update: vi.fn(() => ({
			set: (set: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						state.updated += 1;
						state.lastSet = set;
						return [{ id: TAG_ID }];
					}
				})
			})
		})),
		// Count on `where`, not `returning`: `link`'s detach issues a bare
		// delete with no `.returning()`, so counting there would miss it.
		delete: vi.fn(() => ({
			where: () => {
				state.deleted += 1;
				return {
					returning: async () => [{ id: TAG_ID }]
				};
			}
		}))
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	state.inserted = [];
	state.deleted = 0;
	state.updated = 0;
	state.lastSet = undefined;
	resetDb();
});

describe('tags record load', () => {
	it('404s on a malformed id before touching the database', async () => {
		await expect(loadRecord({ params: { id: 'nope' } } as never)).rejects.toMatchObject({
			status: 404
		});
		expect(dbMock.select).not.toHaveBeenCalled();
	});

	it('never promotes a destructive action to primary', async () => {
		state.selectQueue = [
			[{ id: TAG_ID, name: 'svelte', slug: 'svelte', description: null }],
			[],
			[]
		];
		const result = (await loadRecord({ params: { id: TAG_ID } } as never)) as unknown as {
			headerActions: { iconName: string; variant?: string }[];
			related: unknown[];
			pickable: unknown[];
		};
		const destructive = result.headerActions.find((a) => a.iconName === 'trash');
		expect(destructive?.variant).not.toBe('default');
		expect(result.related).toEqual([]);
		expect(result.pickable).toEqual([]);
	});
});

describe('tags actions', () => {
	it('runs every action behind the admin guard first', async () => {
		await callAction(listActions as ActionSource, 'create');
		await callAction(recordActions as ActionSource, 'update');
		await callAction(recordActions as ActionSource, 'link');
		await callAction(recordActions as ActionSource, 'delete');
		expect(guardMock).toHaveBeenCalledTimes(4);
	});

	it('redirects to the new record after create', async () => {
		dbMock.insert = vi.fn(() => ({
			values: () => ({ returning: async () => [{ id: TAG_ID }] })
		}));
		const { thrown } = await callAction(listActions as ActionSource, 'create', {
			name: 'Svelte',
			slug: 'svelte'
		});
		expect(thrown?.status).toBe(303);
		expect(thrown?.location).toBe(`/admin/posts/tags/${TAG_ID}`);
	});
});

describe('tags link', () => {
	it('rejects an empty selection and an unknown op', async () => {
		expect((await callAction(recordActions as ActionSource, 'link')).result).toMatchObject({
			status: 400
		});
		expect(
			(await callAction(recordActions as ActionSource, 'link', { postId: POST_A, op: 'nope' }))
				.result
		).toMatchObject({ status: 400 });
		expect(state.deleted).toBe(0);
	});

	it('detaches the tag without touching the posts', async () => {
		const { result } = await callAction(recordActions as ActionSource, 'link', {
			postId: [POST_A, POST_B],
			op: 'detach'
		});
		expect(result).toMatchObject({ success: true, changed: 2 });
		// detach issues a delete on post_tags only
		expect(state.deleted).toBe(1);
		expect(state.updated).toBe(0);
	});

	it('attaches the tag to posts that do not carry it yet', async () => {
		dbMock.insert = vi.fn(() => ({
			values: (rows: { postId: string; tagId: string }[]) => ({
				onConflictDoNothing: async () => {
					state.inserted.push(rows);
				}
			})
		}));
		const { result } = await callAction(recordActions as ActionSource, 'link', {
			postId: [POST_A, POST_B],
			op: 'attach'
		});
		expect(result).toMatchObject({ success: true, changed: 2 });
		expect(state.inserted[0]).toEqual([
			{ postId: POST_A, tagId: TAG_ID },
			{ postId: POST_B, tagId: TAG_ID }
		]);
	});
});

describe('tags delete', () => {
	it('rejects a malformed route id', async () => {
		expect(
			(await callAction(recordActions as ActionSource, 'delete', {}, 'nope')).result
		).toMatchObject({ status: 400 });
		expect(state.deleted).toBe(0);
	});

	it('deletes a tag that still has posts — the relation cascades', async () => {
		const { result } = await callAction(recordActions as ActionSource, 'delete');
		expect(result).toMatchObject({ success: true, deleted: TAG_ID });
		expect(state.deleted).toBe(1);
	});
});

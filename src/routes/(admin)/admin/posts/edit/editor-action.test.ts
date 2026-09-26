import { beforeEach, describe, expect, it, vi } from 'vitest';
import { posts, postTags, tags } from '$lib/server/db/content';

/**
 * Route-level tests for the post editor action (P1.1 review: the write path -
 * status mapping, tag sync, uuid guards, constraint translation - had zero
 * coverage). The db module is mocked; schema objects are the real ones so the
 * fake executor can tell the tables apart.
 */
const { dbMock, selectQueue, records, txConfig } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	selectQueue: [] as unknown[][],
	records: {
		postInserts: [] as Record<string, unknown>[],
		postUpdates: [] as Record<string, unknown>[],
		tagUpserts: [] as { name: string; slug: string }[],
		postTagInserts: [] as { postId: string; tagId: string }[],
		postTagDeletes: 0
	},
	txConfig: {
		updatedRows: [{ id: 'updated-post-id' }] as { id: string }[],
		createdId: 'created-post-id',
		failWith: undefined as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));

import { actions } from './+page.server';

type Action = NonNullable<typeof actions.default>;

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

function makeTx() {
	return {
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						if (txConfig.failWith) throw txConfig.failWith;
						if (table !== posts) throw new Error('unexpected update table');
						records.postUpdates.push(values);
						return txConfig.updatedRows;
					}
				})
			})
		}),
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				if (table === tag) {
					return {
						onConflictDoUpdate: () => ({
							returning: async () => {
								records.tagUpserts.push(values as { name: string; slug: string });
								return [{ id: `tag-${values.slug}` }];
							}
						})
					};
				}
				if (table === postTags) {
					return {
						onConflictDoNothing: async () => {
							records.postTagInserts.push(values as { postId: string; tagId: string });
						}
					};
				}
				if (table === posts) {
					return {
						returning: async () => {
							if (txConfig.failWith) throw txConfig.failWith;
							records.postInserts.push(values);
							return [{ id: txConfig.createdId }];
						}
					};
				}
				throw new Error('unexpected insert table');
			}
		}),
		delete: (table: unknown) => ({
			where: async () => {
				if (table !== postTags) throw new Error('unexpected delete table');
				records.postTagDeletes += 1;
			}
		})
	};
}

const tag = tags;

function makeEvent(fields: Record<string, string>) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return { request: new Request('http://localhost/admin/posts/edit', { method: 'POST', body }) };
}

const VALID_CATEGORY = '01900000-0000-7000-8000-000000000001';
const VALID_POST = '01900000-0000-7000-8000-000000000002';

const baseFields = {
	title: 'Hello',
	slug: 'hello-world',
	categoryId: VALID_CATEGORY,
	summary: '',
	content: 'Body',
	tags: 'a, b',
	isPublished: 'true'
};

function resetRecords() {
	records.postInserts.length = 0;
	records.postUpdates.length = 0;
	records.tagUpserts.length = 0;
	records.postTagInserts.length = 0;
	records.postTagDeletes = 0;
}

async function callAction(fields: Record<string, string>) {
	try {
		const result = await (actions.default as Action)(makeEvent(fields) as never);
		return { result, thrown: undefined };
	} catch (thrown) {
		return { result: undefined, thrown };
	}
}

describe('post editor action (P1.1 guards)', () => {
	beforeEach(() => {
		resetRecords();
		selectQueue.length = 0;
		txConfig.updatedRows = [{ id: 'updated-post-id' }];
		txConfig.createdId = 'created-post-id';
		txConfig.failWith = undefined;

		Object.assign(dbMock, {
			query: { posts: { findFirst: vi.fn(async () => null) } },
			select: vi.fn(() => makeChain(selectQueue.shift() ?? [])),
			transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(makeTx()))
		});
	});

	it('rejects a malformed hidden id instead of letting PG raise 22P02', async () => {
		const { result } = await callAction({ ...baseFields, id: 'not-a-uuid' });
		expect(result).toMatchObject({ status: 400 });
		expect((result as { data?: { errors?: { form?: string } } }).data?.errors?.form).toBeTruthy();
		expect(dbMock.transaction).not.toHaveBeenCalled();
	});

	it('rejects a malformed category id with a field error', async () => {
		const { result } = await callAction({ ...baseFields, categoryId: 'cat-1' });
		expect(result).toMatchObject({
			status: 400,
			data: { errors: { categoryId: '请选择有效的分类' } }
		});
	});

	it('creates a published post and syncs its tags inside one transaction', async () => {
		const { thrown } = await callAction(baseFields);
		expect(dbMock.transaction).toHaveBeenCalledTimes(1);
		expect(records.postInserts).toHaveLength(1);
		expect(records.postInserts[0]).toMatchObject({
			status: 'published',
			contentFormat: 'markdown',
			slug: 'hello-world'
		});
		expect(records.postInserts[0].publishedAt).toBeInstanceOf(Date);
		expect(records.postTagDeletes).toBe(1);
		expect(records.tagUpserts.map((t) => t.slug)).toEqual(['a', 'b']);
		expect(records.postTagInserts.map((r) => r.tagId)).toEqual(['tag-a', 'tag-b']);
		expect((thrown as { status?: number; location?: string }).status).toBe(303);
		expect((thrown as { status?: number; location?: string }).location).toContain(
			'id=created-post-id'
		);
	});

	it('maps updates onto the status machine and keeps first-publish stamping', async () => {
		selectQueue.push([{ lang: 'en' }]);
		const { thrown } = await callAction({
			...baseFields,
			id: VALID_POST,
			isPublished: 'false'
		});
		expect(records.postUpdates).toHaveLength(1);
		expect(records.postUpdates[0]).toMatchObject({ status: 'draft' });
		expect(records.postUpdates[0]).not.toHaveProperty('publishedAt');
		expect((thrown as { status?: number }).status).toBe(303);
	});

	it('translates a 23505 slug race into a form error instead of a 500', async () => {
		txConfig.failWith = Object.assign(new Error('duplicate key'), { code: '23505' });
		const { result } = await callAction(baseFields);
		expect(result).toMatchObject({
			status: 400,
			data: { errors: { slug: '该 Slug 已被其他文章使用' } }
		});
	});

	it('translates a 23503 category FK violation into a form error', async () => {
		txConfig.failWith = Object.assign(new Error('fk violation'), { cause: { code: '23503' } });
		const { result } = await callAction(baseFields);
		expect(result).toMatchObject({
			status: 400,
			data: { errors: { categoryId: '分类不存在' } }
		});
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The single "usable translation" predicate: a target row only counts when it
 * is published/scheduled or carries content on the row itself or in its working
 * draft. Four live rows have a target row with no content, so "a row exists"
 * must not be mistaken for "a translation exists".
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		selectCalls: 0,
		fromTables: [] as unknown[],
		joinTables: [] as unknown[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));

import { drafts, notes, posts } from '$lib/server/db/content';
import {
	hasUsableTranslation,
	isUsable,
	translationPresenceForGroup
} from './translation-presence';

const GROUP = 'group-1';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				// Record the tables so dropping the drafts join or reading the
				// wrong source table fails the suite.
				if (prop === 'from') {
					return (table: unknown) => {
						state.fromTables.push(table);
						return self;
					};
				}
				if (prop === 'leftJoin') {
					return (table: unknown) => {
						state.joinTables.push(table);
						return self;
					};
				}
				return () => self;
			}
		}
	);
	return self;
}

beforeEach(() => {
	state.selectQueue = [];
	state.selectCalls = 0;
	state.fromTables = [];
	state.joinTables = [];
	dbMock.select = vi.fn(() => {
		state.selectCalls += 1;
		return makeChain(state.selectQueue.shift() ?? []);
	});
});

describe('isUsable', () => {
	it('accepts published and scheduled rows even when they are empty', () => {
		expect(isUsable('published', false)).toBe(true);
		expect(isUsable('scheduled', false)).toBe(true);
	});

	it('accepts the remaining statuses only when they carry content', () => {
		expect(isUsable('draft', true)).toBe(true);
		expect(isUsable('private', true)).toBe(true);
		expect(isUsable('trash', true)).toBe(true);
		expect(isUsable('draft', false)).toBe(false);
		expect(isUsable('private', false)).toBe(false);
		expect(isUsable('trash', false)).toBe(false);
	});
});

describe('hasUsableTranslation', () => {
	it('counts a published row with empty content', async () => {
		state.selectQueue.push([
			{ postId: 'post-en', lang: 'en', status: 'published', content: '', draftContent: null }
		]);

		await expect(hasUsableTranslation('post', GROUP, 'en')).resolves.toBe(true);
	});

	it('counts a draft row whose own content is non-empty', async () => {
		state.selectQueue.push([
			{ postId: 'post-zh', lang: 'zh-cn', status: 'draft', content: '正文', draftContent: null }
		]);

		await expect(hasUsableTranslation('post', GROUP, 'zh-cn')).resolves.toBe(true);
	});

	it('counts a draft row whose working draft carries the content', async () => {
		state.selectQueue.push([
			{ postId: 'post-ja', lang: 'ja', status: 'draft', content: '', draftContent: 'x' }
		]);

		await expect(hasUsableTranslation('post', GROUP, 'ja')).resolves.toBe(true);
	});

	it('rejects a draft row with empty content and no working draft', async () => {
		state.selectQueue.push([
			{ postId: 'post-ja', lang: 'ja', status: 'draft', content: '   ', draftContent: null }
		]);

		await expect(hasUsableTranslation('post', GROUP, 'ja')).resolves.toBe(false);
	});

	it('rejects a language that has no row in the group', async () => {
		state.selectQueue.push([]);

		await expect(hasUsableTranslation('post', GROUP, 'en')).resolves.toBe(false);
	});
});

describe('translationPresenceForGroup', () => {
	it('keys the map by language and carries the row id and status', async () => {
		state.selectQueue.push([
			{ postId: 'post-en', lang: 'en', status: 'published', content: '', draftContent: null },
			{ postId: 'post-zh', lang: 'zh-cn', status: 'draft', content: '正文', draftContent: null },
			{ postId: 'post-ja', lang: 'ja', status: 'draft', content: '', draftContent: null }
		]);

		await expect(translationPresenceForGroup('post', GROUP)).resolves.toEqual({
			en: { postId: 'post-en', status: 'published', hasContent: false },
			'zh-cn': { postId: 'post-zh', status: 'draft', hasContent: true },
			ja: { postId: 'post-ja', status: 'draft', hasContent: false }
		});
		expect(state.selectCalls).toBe(1);
		expect(state.fromTables).toEqual([posts]);
		expect(state.joinTables).toEqual([drafts]);
	});

	it('reads notes through their own draft rows', async () => {
		state.selectQueue.push([
			{ postId: 'note-en', lang: 'en', status: 'draft', content: '', draftContent: 'draft body' },
			{ postId: 'note-zh', lang: 'zh-cn', status: 'draft', content: '', draftContent: null }
		]);

		await expect(translationPresenceForGroup('note', GROUP)).resolves.toEqual({
			en: { postId: 'note-en', status: 'draft', hasContent: true },
			'zh-cn': { postId: 'note-zh', status: 'draft', hasContent: false }
		});
		expect(state.selectCalls).toBe(1);
		expect(state.fromTables).toEqual([notes]);
		expect(state.joinTables).toEqual([drafts]);
	});

	it('returns an empty map for a group without rows', async () => {
		await expect(translationPresenceForGroup('post', GROUP)).resolves.toEqual({});
	});
});

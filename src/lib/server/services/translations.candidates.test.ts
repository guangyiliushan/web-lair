import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The drawer asks for one group's candidates; `listTranslations` is a global
 * paged workbench read and cannot answer that. These tests pin the narrow
 * query: resolve the group source row first (group + not-translated), then
 * select only that source's candidates, newest first.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectResults: [] as unknown[][],
		selects: [] as unknown[],
		fromTables: [] as unknown[],
		wheres: [] as unknown[],
		orderBys: [] as unknown[],
		limits: [] as number[]
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: vi.fn() }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: vi.fn(),
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/server/ai/translate', () => ({ sourceHash: () => 'source-hash' }));

import { notes, posts, translations } from '$lib/server/db/content';
import { listCandidatesForGroup } from './translations';

const GROUP = 'group-1';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				if (prop === 'from') {
					return (table: unknown) => {
						state.fromTables.push(table);
						return self;
					};
				}
				if (prop === 'where') {
					return (clause: unknown) => {
						state.wheres.push(clause);
						return self;
					};
				}
				if (prop === 'orderBy') {
					return (clause: unknown) => {
						state.orderBys.push(clause);
						return self;
					};
				}
				if (prop === 'limit') {
					return (n: number) => {
						state.limits.push(n);
						return self;
					};
				}
				return () => self;
			}
		}
	);
	return self;
}

type Chunk = {
	constructor?: { name?: string };
	queryChunks?: unknown[];
	value?: unknown;
	name?: string;
	table?: unknown;
};

function walkSql(node: unknown, visit: (node: Chunk) => void) {
	if (!node || typeof node !== 'object') return;
	visit(node as Chunk);
	const chunks = (node as Chunk).queryChunks;
	if (Array.isArray(chunks)) for (const chunk of chunks) walkSql(chunk, visit);
}

/** Column references inside a Drizzle clause, in source order. */
function columnsIn(clause: unknown): unknown[] {
	const out: unknown[] = [];
	walkSql(clause, (node) => {
		if (typeof node.name === 'string' && 'table' in node) out.push(node);
	});
	return out;
}

/** Bound parameter values inside a Drizzle clause, in source order. */
function paramsIn(clause: unknown): unknown[] {
	const out: unknown[] = [];
	walkSql(clause, (node) => {
		if (node.constructor?.name === 'Param') out.push(node.value);
	});
	return out;
}

function textIn(clause: unknown): string {
	let text = '';
	walkSql(clause, (node) => {
		if (node.constructor?.name === 'StringChunk' && Array.isArray(node.value)) {
			text += (node.value as string[]).join('');
		}
	});
	return text;
}

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		id: 'candidate-1',
		targetLang: 'en',
		status: 'draft',
		title: 'Target title',
		content: 'Target body',
		summary: null,
		model: 'gpt-test',
		error: null,
		sourceHash: 'hash-1',
		stage: null,
		waitingReason: null,
		progress: null,
		updatedAt: new Date('2026-11-04T10:00:00Z'),
		...overrides
	};
}

/** The row as the drawer receives it: `progress` is folded into the drawer fields. */
function mapped(row: Record<string, unknown>, partial: string | null = null) {
	const counters = (row.progress ?? null) as {
		done?: number;
		total?: number;
		glossaryMisses?: { term: string; expected: string }[];
	} | null;
	const rest: Record<string, unknown> = { ...row };
	delete rest.progress;
	return {
		...rest,
		partial,
		chunksDone: counters?.done ?? null,
		chunksTotal: counters?.total ?? null,
		glossaryMisses: counters?.glossaryMisses?.length ? counters.glossaryMisses : null
	};
}

beforeEach(() => {
	state.selectResults = [];
	state.selects = [];
	state.fromTables = [];
	state.wheres = [];
	state.orderBys = [];
	state.limits = [];
	dbMock.select = vi.fn((selection: unknown) => {
		state.selects.push(selection);
		return makeChain(state.selectResults.shift() ?? []);
	});
});

describe('listCandidatesForGroup', () => {
	it('returns every candidate of the group, newest first', async () => {
		const newest = candidate({
			id: 'candidate-new',
			status: 'draft',
			content: 'Fresh body',
			updatedAt: new Date('2026-11-04T12:00:00Z')
		});
		const oldest = candidate({
			id: 'candidate-old',
			status: 'discarded',
			content: 'Old body',
			model: null,
			updatedAt: new Date('2026-11-03T12:00:00Z')
		});
		state.selectResults = [[{ id: 'post-1' }], [newest, oldest]];

		await expect(listCandidatesForGroup('post', GROUP)).resolves.toEqual([
			mapped(newest),
			mapped(oldest)
		]);

		expect(dbMock.select).toHaveBeenCalledTimes(2);
	});

	it('carries the streaming partial while the row is still generating', async () => {
		const row = candidate({
			content: null,
			progress: { total: 0, done: 0, chunks: [], partial: '半成品译文' }
		});
		state.selectResults = [[{ id: 'post-1' }], [row]];

		await expect(listCandidatesForGroup('post', GROUP)).resolves.toEqual([
			mapped(row, '半成品译文')
		]);
	});

	it('exposes the chunk counters while a segmented run progresses', async () => {
		const row = candidate({
			content: null,
			progress: { total: 25, done: 7, chunks: [], partial: '第七段' }
		});
		state.selectResults = [[{ id: 'post-1' }], [row]];

		const [result] = await listCandidatesForGroup('post', GROUP);
		expect(result.chunksTotal).toBe(25);
		expect(result.chunksDone).toBe(7);
	});

	it('resolves the group source and filters candidates by that source id', async () => {
		const row = candidate();
		state.selectResults = [[{ id: 'post-1' }], [row]];

		await listCandidatesForGroup('post', GROUP);

		// Source lookup is scoped to the group's untranslated row.
		expect(state.fromTables[0]).toBe(posts);
		expect(state.selects[0]).toEqual({ id: posts.id });
		expect(columnsIn(state.wheres[0])).toEqual(
			expect.arrayContaining([posts.translationGroup, posts.translatedFromPostId])
		);
		expect(paramsIn(state.wheres[0])).toEqual([GROUP]);
		expect(textIn(state.wheres[0])).toContain('is null');
		expect(state.limits[0]).toBe(1);

		// Candidates are selected from `translations` for that exact source
		// only: a row from another source id cannot match this predicate.
		expect(state.fromTables[1]).toBe(translations);
		expect(columnsIn(state.wheres[1])).toContain(translations.sourcePostId);
		expect(columnsIn(state.wheres[1])).not.toContain(translations.sourceNoteId);
		expect(paramsIn(state.wheres[1])).toEqual(['post-1']);
		expect(Object.keys(state.selects[1] as Record<string, unknown>).sort()).toEqual([
			'content',
			'error',
			'id',
			'model',
			'progress',
			'sourceHash',
			'stage',
			'status',
			'summary',
			'targetLang',
			'title',
			'updatedAt',
			'waitingReason'
		]);
	});

	it('orders candidates newest first by creation time', async () => {
		state.selectResults = [[{ id: 'post-1' }], []];

		await listCandidatesForGroup('post', GROUP);

		expect(columnsIn(state.orderBys[0])).toEqual([translations.createdAt]);
		expect(textIn(state.orderBys[0])).toContain('desc');
	});

	it('returns [] without a candidate query when the group has no source', async () => {
		state.selectResults = [[]];

		await expect(listCandidatesForGroup('post', GROUP)).resolves.toEqual([]);

		expect(dbMock.select).toHaveBeenCalledTimes(1);
		expect(state.wheres).toHaveLength(1);
		expect(state.orderBys).toHaveLength(0);
	});

	it('resolves note groups through the note source arc', async () => {
		state.selectResults = [[{ id: 'note-1' }], [candidate()]];

		await listCandidatesForGroup('note', GROUP);

		expect(state.fromTables[0]).toBe(notes);
		expect(state.selects[0]).toEqual({ id: notes.id });
		expect(columnsIn(state.wheres[0])).toEqual(
			expect.arrayContaining([notes.translationGroup, notes.translatedFromNoteId])
		);
		expect(paramsIn(state.wheres[0])).toEqual([GROUP]);
		expect(textIn(state.wheres[0])).toContain('is null');
		expect(state.fromTables[1]).toBe(translations);
		expect(columnsIn(state.wheres[1])).toContain(translations.sourceNoteId);
		expect(columnsIn(state.wheres[1])).not.toContain(translations.sourcePostId);
		expect(paramsIn(state.wheres[1])).toEqual(['note-1']);
	});
});

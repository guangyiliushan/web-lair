import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { drafts, notes } from '$lib/server/db/content';
import { slugTrackers } from '$lib/server/db/system';

/**
 * Service-level tests for the notes draft flow (N1 admin; ledger §9.10 /
 * §13.4): autosave semantics (hash / throttle / optimistic lock), the publish
 * transaction (notes+drafts row locks, slug tracker, field copy, draft
 * removal) and the row-level settings that never enter drafts (§2.3). The db
 * module is mocked with a small executor that records the table of every
 * write, every lock clause and every WHERE condition (rendered with the real
 * dialect) - removing a lock/transaction/condition turns the suite red.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		insertResults: [] as unknown[][],
		updateResults: [] as unknown[][],
		deleteResults: [] as unknown[][],
		updates: [] as { table: unknown; values: Record<string, unknown> }[],
		deletes: [] as { table: unknown }[],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		forCalls: [] as unknown[],
		selectWheres: [] as unknown[],
		updateWheres: [] as unknown[],
		transactions: 0,
		failWith: undefined as unknown
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import {
	discardNoteDraft,
	draftsForNotes,
	isNotePlaceholderSlug,
	noteDraftHash,
	publishNoteDraft,
	saveNoteDraftWork,
	setNoteAllowComment,
	setNoteEmotions,
	setNotePassword,
	setNotePin,
	setNoteStatus
} from './note-drafts';

const dialect = new PgDialect();
const render = (expression: unknown) => dialect.sqlToQuery(expression as SQL);

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				// Record lock clauses so dropping .for('update') fails the suite.
				if (prop === 'for') {
					return (strength: unknown) => {
						state.forCalls.push(strength);
						return self;
					};
				}
				if (prop === 'where') {
					return (...args: unknown[]) => {
						state.selectWheres.push(args[0]);
						return self;
					};
				}
				return () => self;
			}
		}
	);
	return self;
}

function makeExecutors() {
	return {
		select: vi.fn(() => makeChain(state.selectQueue.shift() ?? [])),
		insert: vi.fn((table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				state.inserts.push({ table, values });
				const settle = () => {
					if (state.failWith) throw state.failWith;
					return state.insertResults.shift() ?? [];
				};
				return {
					returning: async () => settle(),
					onConflictDoUpdate: () => ({ returning: async () => settle() }),
					onConflictDoNothing: async () => settle(),
					then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
						Promise.resolve(undefined).then(resolve, reject)
				};
			}
		})),
		update: vi.fn((table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: (...whereArgs: unknown[]) => {
					state.updates.push({ table, values });
					state.updateWheres.push(whereArgs[0]);
					const settle = () => {
						if (state.failWith) throw state.failWith;
						return state.updateResults.shift() ?? [];
					};
					return {
						returning: async () => settle(),
						then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
							Promise.resolve(settle()).then(resolve, reject)
					};
				}
			})
		})),
		delete: vi.fn((table: unknown) => ({
			where: () => ({
				returning: async () => {
					if (state.failWith) throw state.failWith;
					state.deletes.push({ table });
					return state.deleteResults.shift() ?? [{ id: 'deleted' }];
				},
				then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
					if (state.failWith) return Promise.reject(state.failWith).catch(reject);
					state.deletes.push({ table });
					return Promise.resolve([]).then(resolve);
				}
			})
		}))
	};
}

const NOTE_ID = '11111111-1111-1111-1111-111111111111';
const DRAFT_ID = '22222222-2222-2222-2222-222222222222';

const BASE_DRAFT = {
	id: DRAFT_ID,
	refType: 'note',
	refId: NOTE_ID,
	lang: 'en',
	title: 'Old title',
	slug: 'old-slug',
	categoryId: null,
	tags: [],
	content: 'Old content',
	contentFormat: 'markdown',
	summary: null,
	version: 3,
	baseVersion: null,
	author: null,
	updatedAt: new Date('2026-10-02T12:00:00Z'),
	topicId: '33333333-3333-3333-3333-333333333333',
	mood: 'good',
	weatherCode: 2,
	temperatureC: '21.5',
	coordinates: { latitude: 25.03, longitude: 121.56 },
	location: 'Taipei'
};

function payloadFromRow(row: typeof BASE_DRAFT) {
	return {
		title: row.title,
		slug: row.slug ?? '',
		topicId: row.topicId ?? '',
		mood: row.mood ?? '',
		weatherCode: row.weatherCode as string | number | null,
		temperatureC: row.temperatureC as string | null,
		latitude: row.coordinates ? String(row.coordinates.latitude) : '',
		longitude: row.coordinates ? String(row.coordinates.longitude) : '',
		location: row.location ?? '',
		content: row.content ?? ''
	};
}

describe('note draft flow', () => {
	beforeEach(() => {
		state.selectQueue = [];
		state.insertResults = [];
		state.updateResults = [];
		state.deleteResults = [];
		state.updates = [];
		state.deletes = [];
		state.inserts = [];
		state.forCalls = [];
		state.selectWheres = [];
		state.updateWheres = [];
		state.transactions = 0;
		state.failWith = undefined;
		Object.assign(dbMock, {
			...makeExecutors(),
			transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
				state.transactions += 1;
				return callback(makeExecutors());
			})
		});
	});

	it('hashes every member of the write set (a dropped field cannot stay invisible)', () => {
		// Each variant differs in exactly ONE payload field; if the field fell
		// out of noteDraftUpdateSet the hash would stop discriminating it and
		// an edit would silently return `unchanged`.
		const base = payloadFromRow(BASE_DRAFT);
		const baseHash = noteDraftHash(base);
		expect(noteDraftHash(payloadFromRow(BASE_DRAFT))).toBe(baseHash);
		const variants: Partial<typeof base>[] = [
			{ title: 'New title' },
			{ slug: 'other-slug' },
			{ topicId: '' },
			{ mood: '' },
			{ weatherCode: 61 },
			{ temperatureC: '22.5' },
			{ latitude: '', longitude: '' },
			{ location: 'Tainan' },
			{ content: 'New content' }
		];
		for (const variant of variants) {
			expect(noteDraftHash({ ...base, ...variant }), JSON.stringify(variant)).not.toBe(baseHash);
		}
	});

	it('answers unchanged when the payload equals the stored draft', async () => {
		state.selectQueue = [[BASE_DRAFT]];
		const result = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: payloadFromRow(BASE_DRAFT),
			autosave: true
		});
		expect(result).toMatchObject({ kind: 'unchanged', version: 3, noteId: NOTE_ID });
		expect(state.updates).toHaveLength(0);
	});

	it('canonicalises temperature to the numeric(4,1) scale so hashes round-trip', async () => {
		// The form may send '7'; PG reads it back as '7.0'. Without the
		// scale canonicalisation the hash never matched and every autosave
		// rewrote the row (round-7 review finding).
		state.selectQueue = [[{ ...BASE_DRAFT, temperatureC: '7.0', coordinates: null }]];
		const result = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), temperatureC: '7', latitude: '', longitude: '' },
			autosave: true
		});
		expect(result.kind).toBe('unchanged');
		expect(state.updates).toHaveLength(0);
	});

	it('normalises the temperature boundary family (round-first, negative zero)', async () => {
		const cases: [string, string | null][] = [
			['7', '7.0'],
			['-0.04', '0.0'],
			['-0.001', '0.0'],
			['-99.94', '-99.9'],
			['99.94', '99.9'],
			// 99.95 rounds up to 100.0 (JS and PG agree) - past the column.
			['99.95', null],
			['99.96', null],
			['-99.96', null]
		];
		for (const [input, expected] of cases) {
			state.selectQueue = [[BASE_DRAFT]];
			state.updateResults = [[{ id: DRAFT_ID, version: 4, updatedAt: new Date() }]];
			await saveNoteDraftWork({
				draftId: DRAFT_ID,
				payload: { ...payloadFromRow(BASE_DRAFT), temperatureC: input },
				autosave: false
			});
			expect(state.updates.at(-1)?.values.temperatureC, input).toBe(expected);
		}
	});

	it('drops malformed numeric input instead of letting it reach the column', async () => {
		// '2.5.5' / '12.9' pass parseFloat/parseInt but 22P02 (numeric) or
		// silently truncate (smallint) once stored - both must land as null.
		state.selectQueue = [[BASE_DRAFT]];
		state.updateResults = [[{ id: DRAFT_ID, version: 4, updatedAt: new Date() }]];
		const result = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: {
				...payloadFromRow(BASE_DRAFT),
				temperatureC: '2.5.5',
				weatherCode: '12.9',
				latitude: '1e2',
				longitude: '121.56'
			},
			autosave: false
		});
		expect(result.kind).toBe('saved');
		expect(state.updates[0].values).toMatchObject({
			temperatureC: null,
			weatherCode: null,
			coordinates: null
		});
	});

	it('throttles autosave but lets a manual save through; the window expires', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date() }]];
		const throttled = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: true
		});
		expect(throttled.kind).toBe('throttled');
		if (throttled.kind === 'throttled') expect(throttled.retryAfterMs).toBeGreaterThan(0);
		expect(state.updates).toHaveLength(0);

		// Past the 30s window an autosave is allowed again.
		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date(Date.now() - 31_000) }]];
		state.updateResults = [[{ id: DRAFT_ID, version: 4, updatedAt: new Date() }]];
		const afterWindow = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: true
		});
		expect(afterWindow.kind).toBe('saved');

		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date() }]];
		state.updateResults = [[{ id: DRAFT_ID, version: 5, updatedAt: new Date() }]];
		const manual = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: false
		});
		expect(manual).toMatchObject({ kind: 'saved', version: 5 });
		expect(state.updates).toHaveLength(2);
	});

	it('refuses a stale optimistic version with the server state attached', async () => {
		state.selectQueue = [[BASE_DRAFT]];
		const result = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			expectedVersion: 2,
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: false
		});
		expect(result).toMatchObject({
			kind: 'conflict',
			server: { draftId: DRAFT_ID, version: 3 }
		});
		expect(state.updates).toHaveLength(0);
	});

	it('detects a lost conditional update (concurrent save) as a conflict', async () => {
		state.selectQueue = [[BASE_DRAFT], [BASE_DRAFT]];
		state.updateResults = [[]];
		const result = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: false
		});
		expect(result.kind).toBe('conflict');
		expect(state.updates).toHaveLength(1);
		// The conditional update must be pinned to the version we read.
		const rendered = render(state.updateWheres[0]);
		expect(rendered.sql).toContain('"drafts"."version" =');
		expect(rendered.params).toContain(3);
	});

	it('creates a draft row for an existing note without one', async () => {
		state.selectQueue = [[], [{ id: NOTE_ID }]];
		state.insertResults = [[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]];
		const result = await saveNoteDraftWork({
			noteId: NOTE_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), slug: '' },
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'saved', version: 1, noteId: NOTE_ID });
		const insert = state.inserts.find((entry) => entry.table === drafts);
		expect(insert?.values).toMatchObject({
			refType: 'note',
			refId: NOTE_ID,
			version: 1,
			baseVersion: null
		});
		// The draft lookup is scoped to the notes refType.
		const rendered = render(state.selectWheres[0]);
		expect(rendered.sql).toContain('"drafts"."ref_type"');
		expect(rendered.params).toContain('note');
	});

	it('maps a concurrent draft creation (23505) to a conflict', async () => {
		state.selectQueue = [[], [{ id: NOTE_ID }], [{ ...BASE_DRAFT, version: 5 }]];
		state.failWith = Object.assign(new Error('dup'), { code: '23505' });
		const result = await saveNoteDraftWork({
			noteId: NOTE_ID,
			payload: payloadFromRow(BASE_DRAFT),
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'conflict', server: { version: 5 } });
	});

	it('maps a vanished topic (23503) to a graded form error, not a 500', async () => {
		state.selectQueue = [[BASE_DRAFT]];
		state.failWith = Object.assign(new Error('fk'), { code: '23503' });
		const result = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			// The payload must differ from the stored row so the write runs;
			// an identical payload short-circuits to `unchanged` first.
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'invalid' });
		if (result.kind === 'invalid') expect(result.errors.topicId).toBeTruthy();
	});

	it('materializes a placeholder note + draft for a brand-new note (no precondition)', async () => {
		state.insertResults = [
			[{ id: NOTE_ID }],
			[{ id: DRAFT_ID, version: 1, updatedAt: new Date() }]
		];
		const result = await saveNoteDraftWork({
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'First' },
			lang: 'zh-cn',
			autosave: false
		});
		expect(result).toMatchObject({ kind: 'saved', version: 1, noteId: NOTE_ID });
		expect(state.transactions).toBe(1);
		const noteInsert = state.inserts.find((entry) => entry.table === notes);
		expect(noteInsert?.values).toMatchObject({ title: 'First', lang: 'zh-cn', status: 'draft' });
		expect(isNotePlaceholderSlug(String(noteInsert?.values.slug))).toBe(true);
	});

	it('publishes the locked draft: full field copy, tracker, draft removal', async () => {
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: NOTE_ID, slug: 'published-slug', lang: 'en' }], // outer note read
			[{ id: NOTE_ID, slug: 'published-slug', lang: 'en' }], // locked note
			[{ ...BASE_DRAFT, slug: 'new-slug' }] // locked draft
		];
		const result = await publishNoteDraft(DRAFT_ID);
		expect(result).toMatchObject({ kind: 'published', noteId: NOTE_ID });
		expect(state.transactions).toBe(1);
		// Both rows locked, notes first (deadlock-free order).
		expect(state.forCalls).toHaveLength(2);
		const tracker = state.inserts.find((entry) => entry.table === slugTrackers);
		expect(tracker?.values).toMatchObject({ slug: 'published-slug', type: 'note', lang: 'en' });
		const noteUpdate = state.updates.find((entry) => entry.table === notes);
		// Every draft column is copied - dropping any single one must fail here.
		expect(noteUpdate?.values).toMatchObject({
			title: 'Old title',
			slug: 'new-slug',
			topicId: '33333333-3333-3333-3333-333333333333',
			mood: 'good',
			weatherCode: 2,
			temperatureC: '21.5',
			coordinates: { latitude: 25.03, longitude: 121.56 },
			location: 'Taipei',
			content: 'Old content',
			contentFormat: 'markdown',
			status: 'published'
		});
		expect(state.deletes.some((entry) => entry.table === drafts)).toBe(true);
		// First publish time survives a re-publish (coalesce keeps the original).
		const renderedPublishedAt = render(noteUpdate?.values.publishedAt);
		expect(renderedPublishedAt.sql).toContain('coalesce');
		expect(renderedPublishedAt.sql).toContain('"notes"."published_at"');
	});

	it('keeps a same-slug or placeholder-slug publish free of tracker rows', async () => {
		// Same slug: nothing to redirect.
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: NOTE_ID, slug: 'old-slug', lang: 'en' }],
			[{ id: NOTE_ID, slug: 'old-slug', lang: 'en' }],
			[BASE_DRAFT]
		];
		await publishNoteDraft(DRAFT_ID);
		expect(state.inserts.some((entry) => entry.table === slugTrackers)).toBe(false);

		// Placeholder old slug: never published, nothing to redirect.
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: NOTE_ID, slug: 'draft-abc123', lang: 'en' }],
			[{ id: NOTE_ID, slug: 'draft-abc123', lang: 'en' }],
			[{ ...BASE_DRAFT, slug: 'fresh-slug' }]
		];
		await publishNoteDraft(DRAFT_ID);
		expect(state.inserts.some((entry) => entry.table === slugTrackers)).toBe(false);
	});

	it('rejects invalid publish payloads branch by branch before any transaction', async () => {
		const cases: { patch: Record<string, unknown>; key: string; match?: string }[] = [
			{ patch: { title: '  ' }, key: 'title' },
			{ patch: { slug: null }, key: 'slug', match: '不能为空' },
			{ patch: { slug: 'Hello' }, key: 'slug', match: '小写' },
			{ patch: { slug: 'topics' }, key: 'slug', match: '保留词' },
			{ patch: { slug: 'draft-taken' }, key: 'slug', match: '占位' },
			{ patch: { content: '   ' }, key: 'content' },
			{ patch: { mood: 'ecstatic' }, key: 'mood' }
		];
		for (const testCase of cases) {
			state.selectQueue = [[{ ...BASE_DRAFT, ...testCase.patch }], [{ id: NOTE_ID }]];
			const result = await publishNoteDraft(DRAFT_ID);
			expect(result.kind, JSON.stringify(testCase.patch)).toBe('invalid');
			if (result.kind === 'invalid') {
				expect(result.errors[testCase.key], JSON.stringify(testCase.patch)).toBeTruthy();
				if (testCase.match) expect(result.errors[testCase.key]).toContain(testCase.match);
			}
		}
		expect(state.transactions).toBe(0);
	});

	it('re-checks the locked draft inside the transaction (changed under us)', async () => {
		state.selectQueue = [
			[{ ...BASE_DRAFT, slug: 'ok-slug' }],
			[{ id: NOTE_ID }],
			[{ id: NOTE_ID, slug: 'published-slug', lang: 'en' }],
			[{ ...BASE_DRAFT, slug: 'ok-slug', title: '   ' }] // locked copy fails re-check
		];
		const result = await publishNoteDraft(DRAFT_ID);
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') expect(result.errors.form).toContain('变化');
	});

	it('maps a unique violation at publish to slug-taken', async () => {
		state.selectQueue = [[BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT]];
		state.failWith = Object.assign(new Error('dup'), { code: '23505' });
		const result = await publishNoteDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'slug-taken' });
	});

	it('maps deadlock/serialization failures at publish and discard to busy', async () => {
		state.selectQueue = [[BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT]];
		state.failWith = Object.assign(new Error('deadlock'), { code: '40P01' });
		expect(await publishNoteDraft(DRAFT_ID)).toEqual({ kind: 'busy' });

		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: NOTE_ID, status: 'published', publishedAt: new Date() }]
		];
		state.failWith = Object.assign(new Error('serialization'), { code: '40001' });
		expect(await discardNoteDraft(DRAFT_ID)).toEqual({ kind: 'busy' });
	});

	it('discards a placeholder note together with its draft', async () => {
		state.selectQueue = [[BASE_DRAFT], [{ id: NOTE_ID, status: 'draft', publishedAt: null }]];
		state.deleteResults = [[{ id: DRAFT_ID }], []];
		const result = await discardNoteDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', noteId: NOTE_ID, removedPlaceholder: true });
		expect(state.transactions).toBe(1);
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts, notes]);
	});

	it('keeps the note row when it was ever published (publishedAt decides)', async () => {
		// status 'draft' alone is not enough: the note had been public once.
		state.selectQueue = [[BASE_DRAFT], [{ id: NOTE_ID, status: 'draft', publishedAt: new Date() }]];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const result = await discardNoteDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', noteId: NOTE_ID, removedPlaceholder: false });
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts]);

		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: NOTE_ID, status: 'published', publishedAt: new Date() }]
		];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const published = await discardNoteDraft(DRAFT_ID);
		expect(published).toEqual({ kind: 'discarded', noteId: NOTE_ID, removedPlaceholder: false });
	});

	it('sets, keeps and clears the password hash (same value never re-salts)', async () => {
		state.selectQueue = [[{ id: NOTE_ID, passwordHash: null }]];
		state.updateResults = [[{ id: NOTE_ID }]];
		const set = await setNotePassword(NOTE_ID, 'hunter2');
		expect(set).toEqual({ kind: 'ok' });
		const stored = String(state.updates[0].values.passwordHash);
		expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

		// Same password again: verified against the hash we stored, no rewrite
		// (re-salting would revoke every unlock cookie).
		state.selectQueue = [[{ id: NOTE_ID, passwordHash: stored }]];
		expect(await setNotePassword(NOTE_ID, 'hunter2')).toEqual({ kind: 'ok' });
		expect(state.updates).toHaveLength(1);

		// A different password rewrites; empty string clears.
		state.selectQueue = [[{ id: NOTE_ID, passwordHash: stored }]];
		state.updateResults = [[{ id: NOTE_ID }]];
		expect(await setNotePassword(NOTE_ID, 'hunter3')).toEqual({ kind: 'ok' });
		expect(String(state.updates[1].values.passwordHash)).not.toBe(stored);

		state.selectQueue = [[{ id: NOTE_ID, passwordHash: stored }]];
		state.updateResults = [[{ id: NOTE_ID }]];
		await setNotePassword(NOTE_ID, '');
		expect(state.updates[2].values.passwordHash).toBeNull();

		// Clearing when already empty: no write.
		state.selectQueue = [[{ id: NOTE_ID, passwordHash: null }]];
		expect(await setNotePassword(NOTE_ID, '')).toEqual({ kind: 'ok' });
		expect(state.updates).toHaveLength(3);

		// Length guard runs before any db read.
		expect(await setNotePassword(NOTE_ID, 'x'.repeat(201))).toMatchObject({ kind: 'invalid' });
		expect(state.updates).toHaveLength(3);
	});

	it('writes emotions into meta with one jsonb_set (deduped, fail-closed)', async () => {
		state.updateResults = [[{ id: NOTE_ID }]];
		const ok = await setNoteEmotions(NOTE_ID, ['happy', 'brave', 'happy']);
		expect(ok).toEqual({ kind: 'ok' });
		const rendered = render(state.updates[0].values.meta);
		expect(rendered.sql).toContain('jsonb_set');
		expect(rendered.sql).toContain('coalesce');
		// Duplicates collapse before the write.
		expect(rendered.params).toContain(JSON.stringify(['happy', 'brave']));

		const bad = await setNoteEmotions(NOTE_ID, ['starstruck']);
		expect(bad).toMatchObject({ kind: 'invalid' });
		expect(state.updates).toHaveLength(1);

		state.updateResults = [[]];
		expect(await setNoteEmotions(NOTE_ID, ['calm'])).toEqual({ kind: 'not-found' });
	});

	it('maps status actions (restore depends on publishedAt) with a status CAS', async () => {
		state.selectQueue = [
			[{ id: NOTE_ID, status: 'trash', publishedAt: new Date('2026-01-01T00:00:00Z') }],
			[{ id: NOTE_ID, status: 'trash', publishedAt: null }],
			[{ id: NOTE_ID, status: 'published', publishedAt: new Date() }]
		];
		state.updateResults = [[{ id: NOTE_ID }], [{ id: NOTE_ID }], [{ id: NOTE_ID }]];
		await setNoteStatus(NOTE_ID, 'restore');
		expect(state.updates[0].values.status).toBe('published');
		await setNoteStatus(NOTE_ID, 'restore');
		expect(state.updates[1].values.status).toBe('draft');
		await setNoteStatus(NOTE_ID, 'private');
		expect(state.updates[2].values.status).toBe('private');
		// The update is conditional on the status we read.
		const rendered = render(state.updateWheres[0]);
		expect(rendered.sql).toContain('"notes"."status" =');
		expect(rendered.params).toContain('trash');

		// Same-status short-circuit: no write at all.
		state.selectQueue = [[{ id: NOTE_ID, status: 'private', publishedAt: new Date() }]];
		expect(await setNoteStatus(NOTE_ID, 'private')).toEqual({ kind: 'ok' });
		expect(state.updates).toHaveLength(3);

		// CAS miss but the row still exists: converged elsewhere, still ok.
		state.selectQueue = [[{ id: NOTE_ID, status: 'draft', publishedAt: null }], [{ id: NOTE_ID }]];
		state.updateResults = [[]];
		expect(await setNoteStatus(NOTE_ID, 'private')).toEqual({ kind: 'ok' });

		// Row gone: not-found, never a silent ok.
		state.selectQueue = [[]];
		expect(await setNoteStatus(NOTE_ID, 'trash')).toEqual({ kind: 'not-found' });
	});

	it('toggles pin idempotently / allow_comment with a CAS and reports missing rows', async () => {
		state.updateResults = [[{ id: NOTE_ID }], [{ id: NOTE_ID }]];
		expect(await setNotePin(NOTE_ID, true)).toEqual({ kind: 'ok' });
		// Re-pinning coalesces the existing instant instead of drifting.
		const rendered = render(state.updates[0].values.pinAt);
		expect(rendered.sql).toContain('coalesce');
		expect(rendered.sql).toContain('"notes"."pin_at"');
		expect(await setNoteAllowComment(NOTE_ID, false)).toEqual({ kind: 'ok' });
		expect(state.updates[1].values.allowComment).toBe(false);
		const commentWhere = render(state.updateWheres[1]);
		expect(commentWhere.sql).toContain('"notes"."allow_comment"');
		// Direction is pinned: flipping `ne` to `eq` must fail here
		// (verify-round finding).
		expect(commentWhere.sql).toContain('"notes"."allow_comment" <>');

		// Unpin writes null directly.
		state.updateResults = [[{ id: NOTE_ID }]];
		await setNotePin(NOTE_ID, false);
		expect(state.updates[2].values.pinAt).toBeNull();

		// Missing rows: update empty + re-check miss.
		state.updateResults = [[]];
		state.selectQueue = [[]];
		expect(await setNotePin(NOTE_ID, false)).toEqual({ kind: 'not-found' });
	});

	it('reports the notes that carry a pending draft (empty input short-circuits)', async () => {
		state.selectQueue = [[{ refId: NOTE_ID }, { refId: null }]];
		const set = await draftsForNotes([NOTE_ID]);
		expect(set).toEqual(new Set([NOTE_ID]));

		const selectSpy = dbMock.select as ReturnType<typeof vi.fn>;
		selectSpy.mockClear();
		expect(await draftsForNotes([])).toEqual(new Set());
		expect(selectSpy).not.toHaveBeenCalled();
	});
});

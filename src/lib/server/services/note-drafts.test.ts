import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drafts, notes } from '$lib/server/db/content';
import { slugTrackers } from '$lib/server/db/system';

/**
 * Service-level tests for the notes draft flow (N1 admin; ledger §9.10 /
 * §13.4): autosave semantics (hash / throttle / optimistic lock), the publish
 * transaction (notes+drafts row locks, slug tracker, field copy, draft
 * removal) and the row-level settings that never enter drafts (§2.3). The db
 * module is mocked with a small executor that records the table of every
 * write and every lock clause - removing a lock/transaction turns the suite
 * red.
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
				where: () => {
					state.updates.push({ table, values });
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
		weatherCode: row.weatherCode,
		temperatureC: row.temperatureC,
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

	it('hashes the exact write set (payload vs row equality is stable)', () => {
		expect(noteDraftHash(payloadFromRow(BASE_DRAFT))).toBe(
			noteDraftHash(payloadFromRow(BASE_DRAFT))
		);
		expect(noteDraftHash({ ...payloadFromRow(BASE_DRAFT), title: 'New' })).not.toBe(
			noteDraftHash(payloadFromRow(BASE_DRAFT))
		);
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

	it('throttles autosave but lets a manual save through', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date() }]];
		const throttled = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: true
		});
		expect(throttled.kind).toBe('throttled');
		if (throttled.kind === 'throttled') expect(throttled.retryAfterMs).toBeGreaterThan(0);
		expect(state.updates).toHaveLength(0);

		state.selectQueue = [[{ ...BASE_DRAFT, updatedAt: new Date() }]];
		state.updateResults = [[{ id: DRAFT_ID, version: 4, updatedAt: new Date() }]];
		const manual = await saveNoteDraftWork({
			draftId: DRAFT_ID,
			payload: { ...payloadFromRow(BASE_DRAFT), title: 'New title' },
			autosave: false
		});
		expect(manual).toMatchObject({ kind: 'saved', version: 4 });
		expect(state.updates).toHaveLength(1);
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

	it('publishes the locked draft: field copy, tracker, draft removal', async () => {
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
		expect(noteUpdate?.values).toMatchObject({
			slug: 'new-slug',
			status: 'published',
			mood: 'good'
		});
		expect(state.deletes.some((entry) => entry.table === drafts)).toBe(true);
	});

	it('rejects invalid publish payloads before any transaction', async () => {
		state.selectQueue = [[{ ...BASE_DRAFT, title: '  ', slug: 'topics' }], [BASE_DRAFT]];
		const result = await publishNoteDraft(DRAFT_ID);
		expect(result.kind).toBe('invalid');
		if (result.kind === 'invalid') {
			expect(result.errors.title).toBeTruthy();
			expect(result.errors.slug).toContain('保留词');
		}
		expect(state.transactions).toBe(0);
	});

	it('maps a unique violation at publish to slug-taken', async () => {
		state.selectQueue = [[BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT], [BASE_DRAFT]];
		state.failWith = Object.assign(new Error('dup'), { code: '23505' });
		const result = await publishNoteDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'slug-taken' });
	});

	it('discards a placeholder note together with its draft', async () => {
		state.selectQueue = [[BASE_DRAFT], [{ id: NOTE_ID, status: 'draft', publishedAt: null }]];
		state.deleteResults = [[{ id: DRAFT_ID }], []];
		const result = await discardNoteDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', noteId: NOTE_ID, removedPlaceholder: true });
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts, notes]);
	});

	it('keeps a published note row when discarding its draft', async () => {
		state.selectQueue = [
			[BASE_DRAFT],
			[{ id: NOTE_ID, status: 'published', publishedAt: new Date() }]
		];
		state.deleteResults = [[{ id: DRAFT_ID }]];
		const result = await discardNoteDraft(DRAFT_ID);
		expect(result).toEqual({ kind: 'discarded', noteId: NOTE_ID, removedPlaceholder: false });
		expect(state.deletes.map((entry) => entry.table)).toEqual([drafts]);
	});

	it('sets and clears the password hash (empty string clears)', async () => {
		state.updateResults = [[{ id: NOTE_ID }], [{ id: NOTE_ID }]];
		const set = await setNotePassword(NOTE_ID, 'hunter2');
		expect(set).toEqual({ kind: 'ok' });
		const stored = state.updates[0].values.passwordHash;
		expect(String(stored)).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

		await setNotePassword(NOTE_ID, '');
		expect(state.updates[1].values.passwordHash).toBeNull();

		expect(await setNotePassword(NOTE_ID, 'x'.repeat(201))).toMatchObject({ kind: 'invalid' });
	});

	it('writes emotions into meta (fail-closed on unknown tokens)', async () => {
		state.selectQueue = [[{ id: NOTE_ID, meta: { aiGen: { level: 'none' } } }]];
		state.updateResults = [[{ id: NOTE_ID }]];
		const ok = await setNoteEmotions(NOTE_ID, ['happy', 'brave']);
		expect(ok).toEqual({ kind: 'ok' });
		expect(state.updates[0].values.meta).toMatchObject({
			aiGen: { level: 'none' },
			emotions: ['happy', 'brave']
		});

		const bad = await setNoteEmotions(NOTE_ID, ['starstruck']);
		expect(bad).toMatchObject({ kind: 'invalid' });
		expect(state.updates).toHaveLength(1);
	});

	it('maps status actions (restore depends on publishedAt)', async () => {
		state.selectQueue = [
			[{ id: NOTE_ID, status: 'trash', publishedAt: new Date('2026-01-01T00:00:00Z') }],
			[{ id: NOTE_ID, status: 'trash', publishedAt: null }]
		];
		await setNoteStatus(NOTE_ID, 'restore');
		expect(state.updates[0].values.status).toBe('published');
		await setNoteStatus(NOTE_ID, 'restore');
		expect(state.updates[1].values.status).toBe('draft');

		state.selectQueue = [[{ id: NOTE_ID, status: 'published', publishedAt: new Date() }]];
		await setNoteStatus(NOTE_ID, 'private');
		expect(state.updates[2].values.status).toBe('private');
	});

	it('toggles pin / allow_comment and reports missing rows', async () => {
		state.updateResults = [[{ id: NOTE_ID }], [{ id: NOTE_ID }], []];
		expect(await setNotePin(NOTE_ID, true)).toEqual({ kind: 'ok' });
		expect(state.updates[0].values.pinAt).toBeInstanceOf(Date);
		expect(await setNoteAllowComment(NOTE_ID, false)).toEqual({ kind: 'ok' });
		expect(state.updates[1].values.allowComment).toBe(false);
		expect(await setNotePin(NOTE_ID, false)).toEqual({ kind: 'not-found' });
	});

	it('reports the notes that carry a pending draft', async () => {
		state.selectQueue = [[{ refId: NOTE_ID }, { refId: null }]];
		const set = await draftsForNotes([NOTE_ID]);
		expect(set).toEqual(new Set([NOTE_ID]));
	});
});

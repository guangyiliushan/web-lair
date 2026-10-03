import { beforeEach, describe, expect, it, vi } from 'vitest';

// The service module reaches for the db handle and the options registry at
// call time only. The db mock doubles as a queue chain for the read tests.
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][], limitArgs: [] as unknown[] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'UTC') }));

import { NOTE_PAGE_SIZE } from '$lib/utils/note-meta';
import {
	findVisibleNote,
	getNoteBody,
	getNoteGateRecord,
	listNoteSummaries,
	toNoteCard
} from './notes';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return (...args: unknown[]) => {
					if (prop === 'limit') state.limitArgs.push(args[0]);
					return self;
				};
			}
		}
	);
	return self;
}

const base = {
	slug: 'first-night',
	title: 'First night',
	publishedAt: new Date('2026-10-01T00:00:00Z'),
	tz: null,
	content: 'A quiet **evening**. ![cat](/i/cat.png)',
	passwordHash: null,
	pinAt: null
};

describe('toNoteCard', () => {
	it('derives excerpt and cover from the body for open rows', () => {
		const card = toNoteCard(base);
		expect(card).not.toBeNull();
		// plainTextExcerpt reduces images to their alt text (excerpt.test.ts).
		expect(card!.excerpt).toBe('A quiet evening. cat');
		expect(card!.image).toBe('/i/cat.png');
		expect(card!.locked).toBe(false);
	});

	it('never ships derived content for locked rows', () => {
		const card = toNoteCard({ ...base, passwordHash: '$argon2id$...' });
		expect(card!.locked).toBe(true);
		expect(card!.excerpt).toBeNull();
		expect(card!.image).toBeNull();
	});

	it('flags pinned rows and drops rows without a published date', () => {
		expect(toNoteCard({ ...base, pinAt: new Date() })!.pinned).toBe(true);
		expect(toNoteCard({ ...base, publishedAt: null })).toBeNull();
	});

	it('keeps the page size pinned to the agreed 12', () => {
		expect(NOTE_PAGE_SIZE).toBe(12);
	});
});

const detailRow = {
	id: 'n1',
	nid: 1,
	slug: 'first-night',
	title: 'First night',
	content: 'secret body',
	lang: 'en',
	tz: null,
	mood: null,
	weatherCode: null,
	temperatureC: null,
	coordinates: null,
	location: null,
	publishedAt: new Date('2026-10-01T00:00:00Z'),
	pinAt: null,
	allowComment: true,
	translationGroup: 'g1',
	topicName: null,
	topicSlug: null,
	topicIcon: null
};

describe('detail and summary reads (review round 1 teeth)', () => {
	beforeEach(() => {
		state.selectResults = [];
		state.limitArgs = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? []))
		});
	});

	it('findVisibleNote keeps locked bodies and hashes out of page data', async () => {
		state.selectResults = [
			[
				{
					...detailRow,
					content: 'secret ![x](/i/x.png)',
					passwordHash: '$argon2id$hash',
					// Discriminating input: every withheld field is populated on the
					// input row, so dropping any `locked ? null : x` turns this red.
					tz: 'Asia/Taipei',
					mood: 'good',
					weatherCode: 61,
					temperatureC: '21.5',
					coordinates: { latitude: 25.03, longitude: 121.56 },
					location: 'Taipei',
					meta: { emotions: ['happy'] }
				}
			]
		];

		const row = await findVisibleNote('en', 'first-night');

		expect(row?.locked).toBe(true);
		expect(row?.content).toBeNull();
		expect(row?.tz).toBeNull();
		expect(row?.mood).toBeNull();
		expect(row?.emotions).toBeNull();
		expect(row?.weatherCode).toBeNull();
		expect(row?.temperatureC).toBeNull();
		expect(row?.coordinates).toBeNull();
		expect(row?.location).toBeNull();
		expect(row !== null && 'passwordHash' in (row as unknown as Record<string, unknown>)).toBe(
			false
		);
	});

	it('findVisibleNote ships the body for open rows', async () => {
		state.selectResults = [[{ ...detailRow, passwordHash: null }]];

		const row = await findVisibleNote('en', 'first-night');

		expect(row?.locked).toBe(false);
		expect(row?.content).toBe('secret body');
	});

	it('getNoteGateRecord and getNoteBody read the gate columns directly', async () => {
		state.selectResults = [[{ id: 'n1', passwordHash: '$argon2id$hash' }], [{ content: 'body' }]];

		await expect(getNoteGateRecord('n1')).resolves.toEqual({
			id: 'n1',
			passwordHash: '$argon2id$hash'
		});
		await expect(getNoteBody('n1')).resolves.toBe('body');
	});

	it('listNoteSummaries derives the lock flag from the hash and honours the limit', async () => {
		state.selectResults = [
			[
				{
					id: 'n1',
					slug: 'a',
					title: 'A',
					publishedAt: new Date('2026-10-01T00:00:00Z'),
					tz: null,
					passwordHash: null
				},
				{
					id: 'n2',
					slug: 'b',
					title: 'B',
					publishedAt: new Date('2026-10-02T00:00:00Z'),
					tz: 'Asia/Taipei',
					passwordHash: '$argon2id$hash'
				}
			]
		];

		const rows = await listNoteSummaries('en', { limit: 4, now: new Date() });

		expect(rows.map((row) => row.locked)).toEqual([false, true]);
		expect(rows[1].tz).toBe('Asia/Taipei');
		expect(state.limitArgs).toContain(4);
	});
});

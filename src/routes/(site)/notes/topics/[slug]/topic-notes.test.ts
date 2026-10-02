import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the notes topic page (N1 + review round 1): unknown
 * topics 404, known ones render their visible notes - with the topic passed
 * pre-resolved (no duplicate slug lookup) and facets skipped (three queries
 * total).
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: { selectResults: [] as unknown[][] }
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'UTC') }));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	locales: ['en', 'zh-cn', 'ja']
}));

import { load } from './+page.server';

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

const topicRow = {
	id: 't1',
	name: 'Travel',
	slug: 'travel',
	icon: 'plane',
	description: 'Trips',
	sortOrder: 0
};

function makeEvent(slug: string) {
	return {
		params: { slug },
		url: new URL(`http://localhost/en/notes/topics/${slug}`)
	} as never;
}

describe('notes topic page', () => {
	beforeEach(() => {
		state.selectResults = [];
		Object.assign(dbMock, {
			select: vi.fn(() => makeChain(state.selectResults.shift() ?? [])),
			selectDistinct: vi.fn(() => makeChain([]))
		});
	});

	it('404s an unknown topic', async () => {
		state.selectResults = [[]];

		let caught: { status?: number } | null = null;
		try {
			await load(makeEvent('missing'));
		} catch (error) {
			caught = error as { status: number };
		}

		expect(caught?.status).toBe(404);
	});

	it('renders a topic with its visible notes (no facet queries)', async () => {
		state.selectResults = [
			[topicRow],
			[{ total: 1 }],
			[
				{
					slug: 'trip',
					title: 'Trip',
					publishedAt: new Date('2026-10-01T10:00:00Z'),
					tz: null,
					content: 'Hi',
					passwordHash: null,
					pinAt: null
				}
			]
		];

		const data = (await load(makeEvent('travel'))) as {
			topic: unknown;
			notes: unknown[];
			total: number;
		};

		expect(data.topic).toEqual({
			name: 'Travel',
			slug: 'travel',
			icon: 'plane',
			description: 'Trips'
		});
		expect(data.notes).toHaveLength(1);
		expect(data.total).toBe(1);
		// Topic lookup + count + rows only: facets are skipped and the slug is
		// not resolved a second time inside listNotes (review finding).
		expect((dbMock.select as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
		// Facets are skipped entirely: the years query (selectDistinct) must
		// never fire on a topic page (review round 2 - the mutation used to
		// crash with a missing mock instead of failing this assertion).
		expect((dbMock.selectDistinct as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});
});

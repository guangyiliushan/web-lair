import { describe, expect, it, vi } from 'vitest';

// The service module reaches for the db handle and the options registry at
// call time only; the pure projection under test needs neither.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/config/options-registry', () => ({ getOption: vi.fn(async () => 'UTC') }));

import { NOTE_PAGE_SIZE, toNoteCard } from './notes';

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

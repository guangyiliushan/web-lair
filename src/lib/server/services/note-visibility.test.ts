import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
	feedableNoteCondition,
	VISIBLE_NOTE_STATUSES,
	isNoteVisible,
	visibleNoteCondition
} from './note-visibility';

const NOW = new Date('2026-10-02T12:00:00Z');
const PAST = new Date('2026-09-01T00:00:00Z');
const FUTURE = new Date('2026-10-15T00:00:00Z');

/**
 * The state matrix (mirror of the post matrix): every (status, published_at)
 * combination is spelled out, and the SQL condition must agree with the pure
 * mirror. `private` is the notes-only status - finished but never public.
 */
describe('note visibility state matrix', () => {
	const cases: Array<{
		label: string;
		status: string;
		publishedAt: Date | null;
		visible: boolean;
	}> = [
		{ label: 'draft with a past timestamp', status: 'draft', publishedAt: PAST, visible: false },
		{ label: 'draft without a timestamp', status: 'draft', publishedAt: null, visible: false },
		{
			label: 'private with a past timestamp',
			status: 'private',
			publishedAt: PAST,
			visible: false
		},
		{
			label: 'scheduled in the future',
			status: 'scheduled',
			publishedAt: FUTURE,
			visible: false
		},
		{ label: 'scheduled and due (past)', status: 'scheduled', publishedAt: PAST, visible: true },
		{
			label: 'scheduled and due (exactly now)',
			status: 'scheduled',
			publishedAt: NOW,
			visible: true
		},
		{
			label: 'scheduled without a timestamp',
			status: 'scheduled',
			publishedAt: null,
			visible: false
		},
		{ label: 'published in the past', status: 'published', publishedAt: PAST, visible: true },
		{ label: 'published exactly now', status: 'published', publishedAt: NOW, visible: true },
		{
			label: 'published with a future timestamp (never written by the editor)',
			status: 'published',
			publishedAt: FUTURE,
			visible: false
		},
		{
			label: 'published without a timestamp',
			status: 'published',
			publishedAt: null,
			visible: false
		},
		{ label: 'trash with a past timestamp', status: 'trash', publishedAt: PAST, visible: false },
		{
			label: 'unknown status (default-deny)',
			status: 'archived',
			publishedAt: PAST,
			visible: false
		}
	];

	for (const { label, status, publishedAt, visible } of cases) {
		it(`${label} -> ${visible ? 'visible' : 'hidden'}`, () => {
			expect(isNoteVisible({ status, publishedAt }, NOW)).toBe(visible);
		});
	}
});

describe('visibleNoteCondition', () => {
	it('filters on the status whitelist and the published_at cutoff', () => {
		const query = new PgDialect().sqlToQuery(visibleNoteCondition(NOW));
		expect(query.sql).toContain('"notes"."status" in');
		expect(query.sql).toContain('"notes"."published_at" <=');
		// Boolean-structure teeth (review finding): flipping the AND to OR
		// must fail here, not only in the substring checks.
		expect(query.sql).toContain(' and ');
		expect(query.sql).not.toContain(' or ');
		expect(query.params).toEqual([...VISIBLE_NOTE_STATUSES, NOW.toISOString()]);
	});
});

describe('feedableNoteCondition', () => {
	it('adds the password gate exclusion on top of visibility', () => {
		// Teeth: dropping the is-null half would leak gated diary rows into
		// the RSS feed / sitemap (notes plan §3.3).
		const query = new PgDialect().sqlToQuery(feedableNoteCondition(NOW));
		expect(query.sql).toContain('"notes"."status" in');
		expect(query.sql).toContain('"notes"."published_at" <=');
		expect(query.sql).toContain('"notes"."password_hash" is null');
		// Same boolean-structure teeth as the visibility condition.
		expect(query.sql).toContain(' and ');
		expect(query.sql).not.toContain(' or ');
		expect(query.params).toEqual([...VISIBLE_NOTE_STATUSES, NOW.toISOString()]);
	});
});

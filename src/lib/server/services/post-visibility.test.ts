import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { VISIBLE_POST_STATUSES, isPostVisible, visiblePostCondition } from './post-visibility';

const NOW = new Date('2026-09-30T12:00:00Z');
const PAST = new Date('2026-09-01T00:00:00Z');
const FUTURE = new Date('2026-10-15T00:00:00Z');

/**
 * The state matrix (ledger §9.1): every (status, published_at) combination is
 * spelled out — the SQL condition and the pure mirror both have to agree with
 * these expectations. `scheduled` with a past timestamp is the lazy-scheduling
 * case: visible without ever flipping the status.
 */
describe('post visibility state matrix', () => {
	const cases: Array<{
		label: string;
		status: string;
		publishedAt: Date | null;
		visible: boolean;
	}> = [
		{ label: 'draft with a past timestamp', status: 'draft', publishedAt: PAST, visible: false },
		{ label: 'draft without a timestamp', status: 'draft', publishedAt: null, visible: false },
		{
			label: 'scheduled in the future',
			status: 'scheduled',
			publishedAt: FUTURE,
			visible: false
		},
		{
			label: 'scheduled and due (past)',
			status: 'scheduled',
			publishedAt: PAST,
			visible: true
		},
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
			label: 'trash with a future timestamp',
			status: 'trash',
			publishedAt: FUTURE,
			visible: false
		},
		{
			label: 'unknown status (default-deny)',
			status: 'archived',
			publishedAt: PAST,
			visible: false
		}
	];

	for (const { label, status, publishedAt, visible } of cases) {
		it(`${label} -> ${visible ? 'visible' : 'hidden'}`, () => {
			expect(isPostVisible({ status, publishedAt }, NOW)).toBe(visible);
		});
	}
});

describe('visiblePostCondition', () => {
	it('filters on the status whitelist and the published_at cutoff', () => {
		// Teeth for the SQL path: dropping either half of the condition flips
		// these assertions (the e2e nails exercise it against real rows).
		const query = new PgDialect().sqlToQuery(visiblePostCondition(NOW));
		expect(query.sql).toContain('"posts"."status" in');
		expect(query.sql).toContain('"posts"."published_at" <=');
		expect(query.params).toEqual([...VISIBLE_POST_STATUSES, NOW.toISOString()]);
	});
});

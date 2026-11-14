import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * W9.5 migration teeth: the retry columns must exist with the exact defaults
 * the drain relies on, and existing delivery rows must be backfilled to
 * `created_at` (not left at the migration-time `now()`, which would delay a
 * backlog by the age of the row).
 */
const MIGRATION = readFileSync(
	fileURLToPath(new URL('../../../../../drizzle/0005_webhook_delivery_retry.sql', import.meta.url)),
	'utf8'
);
const JOURNAL = readFileSync(
	fileURLToPath(new URL('../../../../../drizzle/meta/_journal.json', import.meta.url)),
	'utf8'
);

describe('webhook delivery retry migration (W9.4/W9.5)', () => {
	it('adds attempt_count as a non-null defaulted column', () => {
		expect(MIGRATION).toMatch(/ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL/);
	});

	it('adds next_attempt_at with a now() default', () => {
		expect(MIGRATION).toMatch(
			/ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now\(\) NOT NULL/
		);
	});

	it('backfills legacy deliveries from created_at', () => {
		expect(MIGRATION).toMatch(/UPDATE "webhook_deliveries" SET "next_attempt_at" = "created_at"/);
	});

	it('keeps the non-negative attempt invariant', () => {
		expect(MIGRATION).toContain('"webhook_deliveries_attempt_count_check"');
		expect(MIGRATION).toContain('"attempt_count" >= 0');
	});

	it('indexes the due query (status, next_attempt_at)', () => {
		expect(MIGRATION).toMatch(
			/CREATE INDEX "webhook_deliveries_due_idx".*\("status","next_attempt_at"\)/
		);
	});

	it('is registered as the newest journal entry', () => {
		const entries = JSON.parse(JOURNAL).entries as Array<{ idx: number; tag: string }>;
		expect(entries.at(-1)).toMatchObject({ idx: 5, tag: '0005_webhook_delivery_retry' });
	});
});

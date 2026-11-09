import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { claimTranslationRow, failTranslationAttempt } from './translation-lease';

/**
 * Real-Postgres teeth for the lease (Task B). Skipped unless
 * `TRANSLATION_SCRATCH_URL` points at a migrated scratch database, and skipped
 * cleanly when that database has not run `0005_translation_runtime` yet.
 *
 *   TRANSLATION_SCRATCH_URL=... pnpm exec vitest run --project server \
 *     src/lib/server/ai/translation-lease.integration.test.ts
 *
 * Seeded rows are dated 2000, so the claim's `order by created_at` picks them
 * before any real pending row, and each test deletes its own rows.
 */
const url = process.env.TRANSLATION_SCRATCH_URL;
const EPOCH = '2000-01-01T00:00:00Z';

describe.skipIf(!url)('translation lease on a scratch database', () => {
	let created: string[] = [];
	let sqlA: ReturnType<typeof postgres>;
	let sqlB: ReturnType<typeof postgres>;
	let dbA: ReturnType<typeof drizzle>;
	let dbB: ReturnType<typeof drizzle>;
	let hasLeaseColumns = false;
	let sourcePostIds: string[] = [];

	async function seedDraft(at: string): Promise<string | null> {
		const postId = sourcePostIds.shift();
		if (!postId) return null;
		const [row] = await sqlA<{ id: string }[]>`
			insert into translations (source_post_id, target_lang, title, origin, created_at)
			values (${postId}, 'en', 'lease-integration', 'ai', ${at}::timestamptz)
			returning id`;
		created.push(row.id);
		return row.id;
	}

	async function cleanup() {
		if (created.length > 0) {
			await sqlA`delete from translations where id = any(${created}::uuid[])`;
		}
		created = [];
	}

	beforeAll(async () => {
		sqlA = postgres(url as string, { max: 1 });
		sqlB = postgres(url as string, { max: 1 });
		dbA = drizzle(sqlA);
		dbB = drizzle(sqlB);

		const [column] = await sqlA`
			select 1 from information_schema.columns
			where table_name = 'translations' and column_name = 'runs'`;
		hasLeaseColumns = column !== undefined;
		if (!hasLeaseColumns) return;

		const posts = await sqlA<{ id: string }[]>`
			select p.id from posts p
			where not exists (
				select 1 from translations t
				where t.source_post_id = p.id and t.target_lang = 'en' and t.status = 'draft'
			)
			order by p.created_at limit 4`;
		sourcePostIds = posts.map((post) => post.id);
	});

	beforeEach(async () => {
		if (!hasLeaseColumns) return;
		await cleanup();
	});

	afterAll(async () => {
		await cleanup();
		await sqlA?.end({ timeout: 5 });
		await sqlB?.end({ timeout: 5 });
	});

	it('two concurrent claims take one row exactly once', async (ctx) => {
		if (!hasLeaseColumns || sourcePostIds.length < 1) return ctx.skip();
		const id = await seedDraft(EPOCH);

		const results = await Promise.all([claimTranslationRow(dbA), claimTranslationRow(dbB)]);
		const winners = results.filter((row): row is NonNullable<typeof row> => row !== null);
		const ids = winners.map((row) => row.id);

		// Never the same row twice; our row goes to exactly one worker.
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.filter((value) => value === id)).toHaveLength(1);
		expect(winners.find((row) => row.id === id)?.runs).toBe(1);

		// A scratch database with other pending rows may hand the second worker
		// one of those; give the incidental lease back.
		const others = ids.filter((value) => value !== id);
		if (others.length > 0) {
			await sqlA`update translations
				set heartbeat_at = null, started_at = null, runs = greatest(runs - 1, 0)
				where id = any(${others}::uuid[])`;
		}
	});

	it('counts three failures and abandons on the third', async (ctx) => {
		if (!hasLeaseColumns) return ctx.skip();
		const id = await seedDraft(EPOCH);
		expect(id).not.toBeNull();

		expect(await failTranslationAttempt(dbA, id as string)).toEqual({
			attempt: 1,
			abandoned: false
		});
		const [afterFirst] = await sqlA<{ error: string | null }[]>`
			select error from translations where id = ${id}`;
		// A retryable row must keep `error` null or the claim never sees it.
		expect(afterFirst.error).toBeNull();

		expect(await failTranslationAttempt(dbA, id as string)).toEqual({
			attempt: 2,
			abandoned: false
		});
		expect(await failTranslationAttempt(dbA, id as string)).toEqual({
			attempt: 3,
			abandoned: true
		});

		const [afterThird] = await sqlA<{ error: string | null; heartbeat_at: Date | null }[]>`
			select error, heartbeat_at from translations where id = ${id}`;
		expect(afterThird.error).toBe('abandoned after 3 failed attempts');
		expect(afterThird.heartbeat_at).toBeNull();
	});

	it('does not reclaim a live lease before the 90s window', async (ctx) => {
		if (!hasLeaseColumns || sourcePostIds.length < 2) return ctx.skip();
		const leased = await seedDraft(EPOCH);
		const next = await seedDraft('2000-01-02T00:00:00Z');
		expect(leased).not.toBeNull();
		expect(next).not.toBeNull();

		await sqlA`update translations set heartbeat_at = now() where id = ${leased}`;
		// The live lease is invisible; the next row is claimed instead.
		expect((await claimTranslationRow(dbA))?.id).toBe(next);

		await sqlA`update translations set heartbeat_at = now() - interval '91 seconds' where id = ${leased}`;
		const stale = await claimTranslationRow(dbA);
		expect(stale?.id).toBe(leased);
		expect(stale?.runs).toBe(1);
	});
});

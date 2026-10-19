/**
 * Backfill the suppression list from existing opt-outs (E2-1, one-off).
 *
 * Rows with `status='unsubscribed'` predate `email_suppressions`; a future bulk
 * sender filters that table, so they must be materialised once. Uses the same
 * keyed hash and `on conflict do nothing` (a stronger bounced/complained row
 * must never be downgraded).
 *
 * Usage: node scripts/backfill-suppressions.ts [--apply]
 * Dry-run needs only DATABASE_URL. `--apply` additionally requires
 * SUPPRESSION_HMAC_KEY (32B base64) and fails closed without it.
 */
import { createHmac } from 'node:crypto';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('[backfill-suppressions] DATABASE_URL is required.');
	process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const KEY = (() => {
	if (!APPLY) return null;
	const raw = (process.env.SUPPRESSION_HMAC_KEY ?? '').trim();
	const key = Buffer.from(raw, 'base64');
	return key.length === 32 ? key : null;
})();
if (APPLY && !KEY) {
	console.error(
		'[backfill-suppressions] SUPPRESSION_HMAC_KEY must be 32 base64-encoded bytes; refusing to write unkeyed hashes'
	);
	process.exit(1);
}

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		const rows = await sql<{ email: string; unsubscribed_at: Date }[]>`
			select email, unsubscribed_at from subscriptions where status = 'unsubscribed'
		`;
		console.log(
			`${APPLY ? 'APPLY' : 'dry-run'} backfill-suppressions: unsubscribed rows=${rows.length}`
		);
		if (!APPLY) {
			if (rows.length > 0) console.log('re-run with --apply to write suppression rows');
			return;
		}
		let inserted = 0;
		let skipped = 0;
		for (const row of rows) {
			// Match the runtime's canonicalizer exactly: valid addresses are
			// trim+lowered by normalizeEmail; legacy addresses rejected by the
			// form regex fall back to trim+lower so their opt-out is not lost.
			const email = row.email.trim().toLowerCase();
			if (!email) {
				skipped += 1;
				continue;
			}
			const hash = createHmac('sha256', KEY!).update(email).digest('hex');
			const result = await sql`
				insert into email_suppressions (email_hash, reason, source, created_at)
				values (${hash}, 'unsubscribed', 'backfill', ${row.unsubscribed_at})
				on conflict (email_hash) do nothing
			`;
			inserted += result.count;
		}
		console.log(
			`inserted ${inserted} suppression rows (${rows.length - inserted - skipped} already present, ${skipped} invalid skipped)`
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error: unknown) => {
	console.error('[backfill-suppressions] failed', error);
	process.exit(1);
});

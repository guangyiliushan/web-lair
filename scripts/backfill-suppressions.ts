/**
 * Backfill the suppression list from existing opt-outs (E2-1, one-off).
 *
 * Rows with `status='unsubscribed'` predate `email_suppressions`; a future bulk
 * sender filters that table, so they must be materialised once. Uses the same
 * keyed hash and `on conflict do nothing` (a stronger bounced/complained row
 * must never be downgraded).
 *
 * Usage: node scripts/backfill-suppressions.ts [--apply]
 * Requires SUPPRESSION_HMAC_KEY (32B base64); fails closed without it.
 */
import { createHmac } from 'node:crypto';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('[backfill-suppressions] DATABASE_URL is required.');
	process.exit(1);
}

const RAW_KEY = process.env.SUPPRESSION_HMAC_KEY ?? '';
const KEY = (() => {
	try {
		const key = Buffer.from(RAW_KEY.trim(), 'base64');
		return key.length === 32 ? key : null;
	} catch {
		return null;
	}
})();
if (!KEY) {
	console.error(
		'[backfill-suppressions] SUPPRESSION_HMAC_KEY must be 32 base64-encoded bytes; refusing to write unkeyed hashes'
	);
	process.exit(1);
}

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		const rows = await sql<{ email: string }[]>`
			select email from subscriptions where status = 'unsubscribed'
		`;
		console.log(
			`${APPLY ? 'APPLY' : 'dry-run'} backfill-suppressions: unsubscribed rows=${rows.length}`
		);
		if (!APPLY) {
			if (rows.length > 0) console.log('re-run with --apply to write suppression rows');
			return;
		}
		let inserted = 0;
		for (const row of rows) {
			const hash = createHmac('sha256', KEY!).update(row.email).digest('hex');
			const result = await sql`
				insert into email_suppressions (email_hash, reason, source)
				values (${hash}, 'unsubscribed', 'backfill')
				on conflict (email_hash) do nothing
			`;
			inserted += result.count;
		}
		console.log(
			`inserted ${inserted} suppression rows (${rows.length - inserted} already present)`
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error: unknown) => {
	console.error('[backfill-suppressions] failed', error);
	process.exit(1);
});

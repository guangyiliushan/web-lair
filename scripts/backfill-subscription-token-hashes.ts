/**
 * Backfill subscription token hashes (E2-3, phase 2).
 *
 * New writes store both `token` (kept for the dual-read window) and
 * `token_hash`. Rows created before this batch have a null hash; this script
 * fills them so reads can hit the hash index and `token` can be dropped in a
 * later window. Safe to re-run: it only selects `token_hash is null`.
 *
 * Usage: node scripts/backfill-subscription-token-hashes.ts [--apply]
 * Default is a dry run.
 */
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('[backfill-token-hashes] DATABASE_URL is required.');
	process.exit(1);
}

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		const rows = await sql<{ id: string; token: string }[]>`
			select id, token from subscriptions where token_hash is null
		`;
		console.log(
			`${APPLY ? 'APPLY' : 'dry-run'} backfill-token-hashes: rows without a hash=${rows.length}`
		);
		if (!APPLY) {
			if (rows.length > 0) console.log('re-run with --apply to write token_hash');
			return;
		}
		let updated = 0;
		for (const row of rows) {
			const hash = createHash('sha256').update(row.token).digest('hex');
			const result = await sql`
				update subscriptions set token_hash = ${hash}
				where id = ${row.id} and token_hash is null and token = ${row.token}
			`;
			updated += result.count;
		}
		console.log(`updated ${updated} rows`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error: unknown) => {
	console.error('[backfill-token-hashes] failed', error);
	process.exit(1);
});

/**
 * Backfill the consent version (E2-2).
 *
 * Rows collected before `subscriptions.consent_version` existed cannot be
 * attributed to a specific text; mark them `legacy` so an export can answer
 * "which version did this reader agree to" without pretending they agreed to
 * the current wording. New writes always set the code constant.
 *
 * Usage: node scripts/backfill-email-consent.ts [--apply]
 * Default is a dry run; `--apply` performs the single UPDATE.
 */
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('[backfill-email-consent] DATABASE_URL is required.');
	process.exit(1);
}

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		const [{ count }] = await sql<{ count: number }[]>`
			select count(*)::int as count from subscriptions where consent_version is null
		`;
		console.log(
			`${APPLY ? 'APPLY' : 'dry-run'} backfill-email-consent: rows without a version=${count}`
		);
		if (!APPLY || count === 0) {
			if (!APPLY && count > 0) console.log('re-run with --apply to write consent_version=legacy');
			return;
		}
		const updated = await sql`
			update subscriptions set consent_version = 'legacy' where consent_version is null
		`;
		console.log(`updated ${updated.count} rows to consent_version=legacy`);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((error: unknown) => {
	console.error('[backfill-email-consent] failed', error);
	process.exit(1);
});

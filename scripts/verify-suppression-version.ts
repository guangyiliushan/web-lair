/**
 * Deployment gate for the suppression key version (F-14).
 *
 * Reads are bounded to versions 1..`SUPPRESSION_HMAC_KEY_VERSION`, so a row
 * written under a *newer* version than the environment advertises would become
 * invisible — a compliance bug (an opted-out address turns mailable). This
 * happens when someone rolls the env version back, or boots an old `.env`
 * against a rotated database.
 *
 * Exit codes: 0 = consistent, 1 = mismatch or bad config.
 * Run it before `up -d`:
 *   deploy/compose-prod.sh run --rm app node scripts/verify-suppression-version.ts
 */
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('[verify-suppression-version] DATABASE_URL is required');
	process.exit(1);
}

const rawVersion = (process.env.SUPPRESSION_HMAC_KEY_VERSION ?? '').trim();
const active = rawVersion === '' ? 1 : Number(rawVersion);
if (!Number.isInteger(active) || active < 1) {
	console.error(
		`[verify-suppression-version] SUPPRESSION_HMAC_KEY_VERSION="${rawVersion}" is not a positive integer`
	);
	process.exit(1);
}

const sql = postgres(DB_URL, { max: 1 });
try {
	const [row] = await sql`
		select coalesce(max(key_version), 0)::int as max_version,
		       count(*)::int as rows
		from email_suppressions
	`;
	const maxVersion = row?.max_version ?? 0;
	if (maxVersion > active) {
		console.error(
			`[verify-suppression-version] email_suppressions has key_version ${maxVersion} but ` +
				`SUPPRESSION_HMAC_KEY_VERSION=${active}. Rows on newer versions would be invisible ` +
				'(reads cover 1..active), so an opt-out could be lost. Set the env back to ' +
				`${maxVersion} (or higher) before starting.`
		);
		process.exit(1);
	}
	console.log(
		`✓ suppression key version ok: max(row)=${maxVersion} active=${active} rows=${row?.rows ?? 0}`
	);
} finally {
	await sql.end({ timeout: 5 });
}

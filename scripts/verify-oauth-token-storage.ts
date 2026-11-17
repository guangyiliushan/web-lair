/**
 * Deployment gate for OAuth token encryption.
 *
 * `account.encryptOAuthTokens` stores OAuth access/refresh tokens as
 * `$ba$<key-version>$<hex>` envelopes (XChaCha20-Poly1305); with no keyring
 * configured they are bare hex. Rows written before the switch are plaintext
 * and keep working (better-auth only decrypts values that look encrypted), so a
 * rollout needs no backfill - they are rewritten on the next sign-in/refresh.
 * This script reports the split per provider and never prints or hashes a
 * token.
 *
 * "Encrypted" mirrors better-auth's own test: a `$ba$<v>$...` envelope, or a
 * bare even-length hex string. A provider whose plaintext tokens are themselves
 * hex-shaped would therefore read as encrypted - today only GitHub
 * (`gho_`/`ghu_` prefixes) is configured, so the check is accurate for the
 * deployed providers.
 *
 * Exit codes: 0 = every stored OAuth token is encrypted (or none exist),
 * 1 = plaintext rows remain (expected right after the switch, green once the
 * affected accounts sign in again) or the config is unusable.
 *
 * Run it from the app image so DATABASE_URL and the keyring are the deployed
 * ones:
 *   deploy/compose-prod.sh run --rm app node scripts/verify-oauth-token-storage.ts
 */
import postgres from 'postgres';

interface TokenRow {
	provider_id: string;
	access_tokens: number;
	encrypted_access: number;
	refresh_tokens: number;
	encrypted_refresh: number;
}

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('[verify-oauth-token-storage] DATABASE_URL is required');
	process.exit(1);
}

const sql = postgres(DB_URL, { max: 1 });

try {
	const rows = (await sql`
		select provider_id,
		       count(*) filter (where nullif(access_token, '') is not null)::int as access_tokens,
		       count(*) filter (
		         where nullif(access_token, '') is not null
		           and (
		             access_token like '$ba$%'
		             or (access_token ~ '^[0-9a-f]+$' and length(access_token) % 2 = 0)
		           )
		       )::int as encrypted_access,
		       count(*) filter (where nullif(refresh_token, '') is not null)::int as refresh_tokens,
		       count(*) filter (
		         where nullif(refresh_token, '') is not null
		           and (
		             refresh_token like '$ba$%'
		             or (refresh_token ~ '^[0-9a-f]+$' and length(refresh_token) % 2 = 0)
		           )
		       )::int as encrypted_refresh
		from account
		where provider_id <> 'credential'
		group by provider_id
		order by provider_id
	`) as TokenRow[];

	let plaintext = 0;
	for (const row of rows) {
		plaintext +=
			row.access_tokens - row.encrypted_access + (row.refresh_tokens - row.encrypted_refresh);
		console.log(
			`${row.provider_id}: access ${row.encrypted_access}/${row.access_tokens} encrypted, ` +
				`refresh ${row.encrypted_refresh}/${row.refresh_tokens} encrypted`
		);
	}

	if (plaintext > 0) {
		console.error(
			`[verify-oauth-token-storage] ${plaintext} plaintext OAuth token(s) remain; ` +
				'they stay readable and are rewritten on the next sign-in/refresh'
		);
		process.exitCode = 1;
	} else {
		console.log('✓ every stored OAuth token is encrypted');
	}
} catch (error) {
	console.error('[verify-oauth-token-storage] query failed', error);
	process.exitCode = 1;
} finally {
	await sql.end();
}

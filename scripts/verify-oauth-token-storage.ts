/**
 * Deployment gate for OAuth token encryption: reports the encrypted/plain split per
 * provider; never prints or hashes a token. `account.encryptOAuthTokens` stores
 * `$ba$<key-version>$<hex>` (XChaCha20-Poly1305); with no keyring tokens are bare hex.
 * Pre-switch plaintext rows keep working and are rewritten on next sign-in/refresh.
 * "Encrypted" mirrors better-auth's own test: a `$ba$<v>$...` envelope or a bare
 * even-length hex string, so hex-shaped plaintext counts as encrypted; only
 * GitHub (`gho_`/`ghu_`) is configured today, so the check is accurate.
 * Exit codes: 0 = every stored OAuth token encrypted (or none exist); 1 =
 * plaintext rows remain (expected right after the switch) or config unusable.
 * Run from the app image (deployed DATABASE_URL and keyring):
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

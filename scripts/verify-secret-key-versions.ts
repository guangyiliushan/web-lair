/**
 * Keyring coverage check (W2.2/W2.10).
 *
 * A key version that a row still references must exist in `SECRETS_KEYS`;
 * otherwise that row can never be read again. Run this before retiring an old
 * version (phase 3 of the rotation) and before restoring a dump.
 *
 * Usage:
 *   node --env-file=.env scripts/verify-secret-key-versions.ts
 *
 * Exit codes: 0 = every referenced version is present, 1 = a referenced
 * version is missing (do NOT retire anything), 2 = configuration error.
 */
import postgres from 'postgres';
import { loadKeyring } from '../src/lib/server/secrets/resolver.ts';
import { SecretError } from '../src/lib/server/secrets/errors.ts';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('[secret-keys] DATABASE_URL is not set');
	process.exit(2);
}
let keyring;
try {
	keyring = loadKeyring({ getEnv: (name) => process.env[name] });
} catch (error) {
	console.error(
		'[secret-keys]',
		error instanceof SecretError ? error.message : 'SECRETS keyring is invalid'
	);
	process.exit(2);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
try {
	const rows = await client<{ kind: string; key_version: number; rows: string }[]>`
		select 'ai_provider_secrets' as kind, key_version, count(*)::text as rows
		from ai_provider_secrets group by key_version
		union all
		select 'webhook_secrets.current' as kind, key_version, count(*)::text as rows
		from webhook_secrets group by key_version
		union all
		select 'webhook_secrets.previous' as kind, previous_key_version as key_version, count(*)::text as rows
		from webhook_secrets where previous_key_version is not null group by previous_key_version
		order by 1, 2
	`;
	const missing = rows.filter((row) => keyring.resolve(Number(row.key_version)) === null);
	const used = new Set(rows.map((row) => Number(row.key_version)));

	console.log(
		`[secret-keys] active version ${keyring.activeVersion}; keyring has ${[...keyring.versions.keys()].sort((a, b) => a - b).join(', ')}`
	);
	for (const row of rows) {
		console.log(`[secret-keys] ${row.kind}: v${row.key_version} (${row.rows} rows)`);
	}
	if (rows.length === 0) console.log('[secret-keys] no encrypted rows yet');
	if (!used.has(keyring.activeVersion)) {
		console.log('[secret-keys] active version has no rows yet (expected before the first write)');
	}
	if (missing.length > 0) {
		for (const row of missing) {
			console.error(
				`[secret-keys] MISSING v${row.key_version} referenced by ${row.kind} (${row.rows} rows)`
			);
		}
		console.error(
			'[secret-keys] add the missing version(s) to SECRETS_KEYS before retiring or restoring'
		);
		process.exitCode = 1;
	}
} finally {
	await client.end({ timeout: 5 });
}

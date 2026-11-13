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
import { ciphertextKeyVersion } from '../src/lib/server/secrets/crypto.ts';
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
	const rows = await client<
		{
			kind: string;
			ciphertext: string;
			key_version: number;
			expires_at: Date | null;
		}[]
	>`
		select 'ai_provider_secrets' as kind, ciphertext, key_version, null::timestamptz as expires_at
		from ai_provider_secrets
		union all
		select 'webhook_secrets.current' as kind, ciphertext, key_version, null::timestamptz
		from webhook_secrets
		union all
		select 'webhook_secrets.previous' as kind, previous_ciphertext as ciphertext,
			previous_key_version as key_version, previous_expires_at as expires_at
		from webhook_secrets where previous_ciphertext is not null
	`;
	const now = Date.now();
	const counts = new Map<string, number>();
	const referenced = new Map<number, number>();
	const missing: string[] = [];
	const mismatched: string[] = [];

	for (const row of rows) {
		if (row.expires_at && row.expires_at.getTime() <= now) continue;
		let version: number;
		try {
			version = ciphertextKeyVersion(row.ciphertext);
		} catch {
			mismatched.push(`${row.kind}: unreadable envelope`);
			continue;
		}
		if (version !== Number(row.key_version)) {
			mismatched.push(`${row.kind}: envelope v${version} but column v${row.key_version}`);
		}
		counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
		referenced.set(version, (referenced.get(version) ?? 0) + 1);
		if (keyring.resolve(version) === null) missing.push(`${row.kind}: v${version}`);
	}

	console.log(
		`[secret-keys] active version ${keyring.activeVersion}; keyring has ${[...keyring.versions.keys()].sort((a, b) => a - b).join(', ')}`
	);
	for (const [kind, count] of counts) console.log(`[secret-keys] ${kind}: ${count} live rows`);
	for (const [version, count] of referenced) {
		console.log(`[secret-keys] v${version} referenced by ${count} live row(s)`);
	}
	if (rows.length === 0) console.log('[secret-keys] no encrypted rows yet');
	if (referenced.size === 0) {
		console.log(
			'[secret-keys] active version has no live rows yet (expected before the first write)'
		);
	}
	if (mismatched.length > 0) {
		for (const item of mismatched) console.error(`[secret-keys] ENVELOPE/COLUMN MISMATCH ${item}`);
		process.exitCode = 1;
	}
	if (missing.length > 0) {
		for (const item of missing) {
			console.error(`[secret-keys] MISSING key version for ${item}`);
		}
		console.error(
			'[secret-keys] add the missing version(s) to SECRETS_KEYS before retiring or restoring'
		);
		process.exitCode = 1;
	}
} finally {
	await client.end({ timeout: 5 });
}

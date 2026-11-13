/**
 * Keyring coverage check (W2.2/W2.10).
 *
 * A key version that a row still references must exist in `SECRETS_KEYS`;
 * otherwise that row can never be read again. Run this before retiring an old
 * version (phase 3 of the rotation) and before restoring a dump.
 *
 * `--retire <n>` answers the phase-3 question directly: every live row whose
 * envelope says v<n> is listed and the exit code is 1, so the gate can fail at
 * the moment it matters (while the version is still in SECRETS_KEYS).
 *
 * Every live row is also decrypted with its real AAD: a same-version/different-
 * key restore passes a presence check but fails here.
 *
 * Usage:
 *   node --env-file=.env scripts/verify-secret-key-versions.ts [--retire 1]
 *
 * Exit codes: 0 = every referenced version is present and readable, 1 = a
 * referenced version is missing / unreadable / still referenced by --retire,
 * 2 = configuration error.
 */
import postgres from 'postgres';
import { loadKeyring } from '../src/lib/server/secrets/resolver.ts';
import {
	ciphertextKeyVersion,
	decryptSecret,
	secretAad
} from '../src/lib/server/secrets/crypto.ts';
import { SecretError } from '../src/lib/server/secrets/errors.ts';

const retireIndex = process.argv.findIndex((arg) => arg === '--retire');
const retireRaw =
	process.argv.find((arg) => arg.startsWith('--retire='))?.slice('--retire='.length) ??
	(retireIndex >= 0 ? process.argv[retireIndex + 1] : undefined);
const RETIRE = retireRaw === undefined ? null : Number(retireRaw);
if (RETIRE !== null && (!Number.isInteger(RETIRE) || RETIRE < 1)) {
	console.error('[secret-keys] --retire expects a positive integer version');
	process.exit(2);
}

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
			row_id: string;
			ciphertext: string;
			key_version: number;
			expires_at: Date | null;
		}[]
	>`
		select 'ai_provider_secrets' as kind, provider_id as row_id, ciphertext, key_version,
			null::timestamptz as expires_at
		from ai_provider_secrets
		union all
		select 'webhook_secrets.current' as kind, webhook_id as row_id, ciphertext, key_version,
			null::timestamptz
		from webhook_secrets
		union all
		select 'webhook_secrets.previous' as kind, webhook_id as row_id,
			previous_ciphertext as ciphertext, previous_key_version as key_version,
			previous_expires_at as expires_at
		from webhook_secrets where previous_ciphertext is not null
	`;
	const now = Date.now();
	const counts = new Map<string, number>();
	const referenced = new Map<number, number>();
	const missing: string[] = [];
	const mismatched: string[] = [];
	const unreadable: string[] = [];
	const retiring: string[] = [];

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
		if (RETIRE !== null && version === RETIRE) retiring.push(`${row.kind} (${row.row_id})`);
		// Presence is not readability: a dump restored with the same version
		// number but different key bytes must fail here, not at request time.
		const table = row.kind === 'ai_provider_secrets' ? 'ai_provider_secrets' : 'webhook_secrets';
		const field = row.kind === 'webhook_secrets.previous' ? 'previous_ciphertext' : 'ciphertext';
		try {
			decryptSecret(row.ciphertext, keyring.resolve, secretAad(table, row.row_id, field));
		} catch (error) {
			const code = error instanceof SecretError ? error.code : 'unknown';
			unreadable.push(`${row.kind} (${row.row_id}): ${code}`);
		}
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
	if (unreadable.length > 0) {
		for (const item of unreadable) {
			console.error(`[secret-keys] UNREADABLE ${item}`);
		}
		console.error(
			'[secret-keys] a live row does not decrypt with this keyring; wrong key bytes or AAD'
		);
		process.exitCode = 1;
	}
	if (RETIRE !== null) {
		if (retiring.length === 0) {
			console.log(`[secret-keys] v${RETIRE} is not referenced by any live row; safe to retire`);
		} else {
			for (const item of retiring) {
				console.error(`[secret-keys] STILL REFERENCED BY v${RETIRE}: ${item}`);
			}
			console.error(
				`[secret-keys] do NOT remove v${RETIRE} from SECRETS_KEYS until these rows are re-encrypted or expired`
			);
			process.exitCode = 1;
		}
	}
} finally {
	await client.end({ timeout: 5 });
}

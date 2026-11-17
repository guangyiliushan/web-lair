/**
 * Webhook secret backfill: encrypts every legacy plaintext `webhooks.secret`
 * into `webhook_secrets` and NULLs the legacy column, so no plaintext
 * signing secret stays in the database. Dry-run by default; `--apply`
 * writes. Idempotent - rows that already have an entry are skipped.
 * Usage: `pnpm db:migrate-webhook-secrets [--apply]`.
 * Exit codes: 0 done (including "nothing to do"), 1 a row failed, 2 config
 * error. Container form and rollback: `deploy/RUNBOOK.md` -> "Retire the
 * legacy webhook secret".
 */
import postgres from 'postgres';
import { loadKeyring } from '../src/lib/server/secrets/resolver.ts';
import { encryptWebhookSecretValue } from '../src/lib/server/secrets/webhook-secrets.ts';
import { decryptSecret, secretAad } from '../src/lib/server/secrets/crypto.ts';
import { SecretError } from '../src/lib/server/secrets/errors.ts';

const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('[webhook-secrets] DATABASE_URL is not set');
	process.exit(2);
}

let keyring;
try {
	keyring = loadKeyring({ getEnv: (name) => process.env[name] });
} catch (error) {
	console.error(
		'[webhook-secrets]',
		error instanceof SecretError ? error.message : 'SECRETS keyring is invalid'
	);
	process.exit(2);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
let failed = 0;
try {
	const rows = await client<{ id: string; name: string; secret: string }[]>`
		select w.id, w.name, w.secret
		from webhooks w
		left join webhook_secrets s on s.webhook_id = w.id
		where w.secret is not null and s.webhook_id is null
		order by w.created_at
	`;
	if (rows.length === 0) {
		console.log('[webhook-secrets] nothing to migrate');
	} else if (!APPLY) {
		for (const row of rows) {
			try {
				const encrypted = encryptWebhookSecretValue(row.id, row.secret, keyring);
				const reopened = decryptSecret(
					encrypted.ciphertext,
					keyring.resolve,
					secretAad('webhook_secrets', row.id, 'ciphertext')
				).plaintext;
				if (reopened !== row.secret) {
					throw new Error('round-trip mismatch; refusing to retire the plaintext value');
				}
				console.log(`[webhook-secrets] would migrate ${row.name} (${row.id}) ${encrypted.hint}`);
			} catch (error) {
				failed += 1;
				console.error(
					`[webhook-secrets] failed ${row.name} (${row.id}):`,
					error instanceof Error ? error.message : error
				);
			}
		}
		console.log(
			`[webhook-secrets] ${rows.length} row(s) pending (dry run; pass --apply), ${failed} failed`
		);
	} else {
		// All-or-nothing: a half-migrated table is a state the rollback
		// runbook cannot describe, and one bad row must not retire any
		// plaintext. The table is small, so the transaction is cheap.
		const migrated: { id: string; name: string; hint: string }[] = [];
		try {
			await client.begin(async (tx) => {
				for (const row of rows) {
					const encrypted = encryptWebhookSecretValue(row.id, row.secret, keyring);
					// Fail before the plaintext is NULLed if the envelope does not
					// round-trip: a keyring bug must not destroy the only copy.
					const reopened = decryptSecret(
						encrypted.ciphertext,
						keyring.resolve,
						secretAad('webhook_secrets', row.id, 'ciphertext')
					).plaintext;
					if (reopened !== row.secret) {
						throw new Error('round-trip mismatch; refusing to retire the plaintext value');
					}
					await tx`
						insert into webhook_secrets
							(webhook_id, ciphertext, hint, key_version)
						values
							(${row.id}, ${encrypted.ciphertext}, ${encrypted.hint}, ${encrypted.keyVersion})
						on conflict (webhook_id) do nothing
					`;
					// Compare-and-set: a rotation that commits between the read
					// and this update must abort the backfill, not be erased.
					const updated = await tx<{ id: string }[]>`
						update webhooks
						set secret = null
						where id = ${row.id} and secret = ${row.secret}
						returning id
					`;
					if (updated.length === 0) {
						throw new Error(`legacy secret for ${row.id} changed during backfill; aborting`);
					}
					migrated.push({ id: row.id, name: row.name, hint: encrypted.hint });
				}
			});
			for (const row of migrated) {
				console.log(`[webhook-secrets] migrated ${row.name} (${row.id}) ${row.hint}`);
			}
			console.log(`[webhook-secrets] ${rows.length} row(s) processed, 0 failed`);
		} catch (error) {
			failed = rows.length;
			console.error(
				'[webhook-secrets] apply aborted; transaction rolled back, NO plaintext was retired:',
				error instanceof Error ? error.message : error
			);
		}
	}
} finally {
	await client.end({ timeout: 5 });
}
if (failed > 0) process.exit(1);

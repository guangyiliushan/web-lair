/**
 * Webhook secret backfill (W2.6).
 *
 * Encrypts every legacy plaintext `webhooks.secret` into `webhook_secrets`.
 * Default is a dry run: it prints what would move and writes nothing. With
 * `--apply` it inserts the encrypted rows and NULLs the legacy column, so no
 * plaintext signing secret remains in the database.
 *
 * Idempotent: a row that already has a `webhook_secrets` entry is skipped, and
 * a second run finds nothing left to do.
 *
 * Usage:
 *   node --env-file=.env scripts/migrate-webhook-secrets.ts [--apply]
 *
 * Exit codes: 0 = done (including "nothing to do"), 1 = a row failed,
 * 2 = configuration error.
 */
import postgres from 'postgres';
import { loadKeyring } from '../src/lib/server/secrets/resolver.ts';
import { encryptWebhookSecretValue } from '../src/lib/server/secrets/webhook-secrets.ts';
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
	} else {
		for (const row of rows) {
			try {
				const encrypted = encryptWebhookSecretValue(row.id, row.secret, keyring);
				if (APPLY) {
					await client.begin(async (tx) => {
						await tx`
							insert into webhook_secrets
								(webhook_id, ciphertext, hint, key_version)
							values
								(${row.id}, ${encrypted.ciphertext}, ${encrypted.hint}, ${encrypted.keyVersion})
							on conflict (webhook_id) do nothing
						`;
						await tx`update webhooks set secret = null where id = ${row.id}`;
					});
					console.log(`[webhook-secrets] migrated ${row.name} (${row.id}) ${encrypted.hint}`);
				} else {
					console.log(`[webhook-secrets] would migrate ${row.name} (${row.id}) ${encrypted.hint}`);
				}
			} catch (error) {
				failed += 1;
				console.error(
					`[webhook-secrets] failed ${row.name} (${row.id}):`,
					error instanceof Error ? error.message : error
				);
			}
		}
		console.log(
			`[webhook-secrets] ${rows.length} row(s) ${APPLY ? 'processed' : 'pending (dry run; pass --apply)'}, ${failed} failed`
		);
	}
} finally {
	await client.end({ timeout: 5 });
}
if (failed > 0) process.exit(1);

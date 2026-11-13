import { eq, inArray } from 'drizzle-orm';
import { webhookSecrets } from '../db/system/webhook-secret.schema.ts';
import { webhooks } from '../db/system/webhook.schema.ts';
import { decryptSecret, encryptSecret, secretAad } from './crypto.ts';
import { SecretError, isSecretError } from './errors.ts';
import { loadKeyring, type SecretDb, type ResolveDeps } from './resolver.ts';
import { maskWebhookSecret } from '../webhooks/secret.ts';

/**
 * Webhook signing-secret resolver and write helpers (W2.6, decisions T1-A/T2-A).
 *
 * Read order: `webhook_secrets` -> legacy `webhooks.secret` -> missing. The
 * legacy column is only a migration/rollback bridge: an un-migrated endpoint
 * must keep verifying after the code deploy, and a rollback must be symmetric
 * until `scripts/migrate-webhook-secrets.ts --apply` has run.
 *
 * The delivery path needs the CURRENT secret and, inside a rotation grace
 * window, the PREVIOUS one so Standard Webhooks can carry two signatures.
 * Neither value ever reaches page data, logs or audit payloads.
 *
 * No `$lib`/`$env` imports (the drain loads this under plain Node).
 */

/** Grace window: covers every in-flight retry plus one release cycle. */
export const WEBHOOK_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

export interface ResolvedWebhookSecrets {
	current: string;
	previous: string | null;
	source: 'db' | 'legacy';
	previousExpiresAt: Date | null;
}

interface WebhookSecretRow {
	ciphertext: string;
	keyVersion: number;
	previousCiphertext: string | null;
	previousKeyVersion: number | null;
	previousExpiresAt: Date | null;
}

async function readSecretRow(db: SecretDb, webhookId: string): Promise<WebhookSecretRow | null> {
	try {
		const rows = await db
			.select<WebhookSecretRow>({
				ciphertext: webhookSecrets.ciphertext,
				keyVersion: webhookSecrets.keyVersion,
				previousCiphertext: webhookSecrets.previousCiphertext,
				previousKeyVersion: webhookSecrets.previousKeyVersion,
				previousExpiresAt: webhookSecrets.previousExpiresAt
			})
			.from(webhookSecrets)
			.where(eq(webhookSecrets.webhookId, webhookId))
			.limit(1);
		return rows[0] ?? null;
	} catch (error) {
		console.warn(
			'[secrets] webhook secret store read failed',
			error instanceof Error ? error.name : 'unknown'
		);
		throw new SecretError('store_unavailable', 'Webhook secret store unavailable');
	}
}

async function readLegacySecret(db: SecretDb, webhookId: string): Promise<string | null> {
	try {
		const rows = await db
			.select<{ secret: string | null }>({ secret: webhooks.secret })
			.from(webhooks)
			.where(eq(webhooks.id, webhookId))
			.limit(1);
		const secret = rows[0]?.secret;
		return secret && secret.length > 0 ? secret : null;
	} catch (error) {
		console.warn(
			'[secrets] webhook legacy secret read failed',
			error instanceof Error ? error.name : 'unknown'
		);
		throw new SecretError('store_unavailable', 'Webhook store unavailable');
	}
}

/** Decrypt one envelope with the row-bound AAD (`field` selects current/previous). */
function decryptValue(
	value: string,
	webhookId: string,
	field: 'ciphertext' | 'previous_ciphertext',
	deps: ResolveDeps
): string {
	const keyring = loadKeyring(deps);
	const aad = secretAad('webhook_secrets', webhookId, field);
	return decryptSecret(value, keyring.resolve, aad).plaintext;
}

/**
 * Resolve the signing secrets for one endpoint at delivery time. Throws
 * `SecretError`: `missing` (no row and no legacy value), `decrypt_failed`,
 * `unknown_key_version` or `store_unavailable`.
 */
export async function resolveWebhookSigningSecrets(
	db: SecretDb,
	webhookId: string,
	deps: ResolveDeps,
	now: Date = new Date()
): Promise<ResolvedWebhookSecrets> {
	const row = await readSecretRow(db, webhookId);
	if (row) {
		const current = decryptValue(row.ciphertext, webhookId, 'ciphertext', deps);
		let previous: string | null = null;
		let previousExpiresAt: Date | null = null;
		if (row.previousCiphertext && row.previousExpiresAt) {
			if (row.previousExpiresAt.getTime() > now.getTime()) {
				try {
					previous = decryptValue(row.previousCiphertext, webhookId, 'previous_ciphertext', deps);
					previousExpiresAt = row.previousExpiresAt;
				} catch (error) {
					// The previous value is a compatibility extra, not the
					// credential the delivery needs. A retired key version or a
					// damaged grace slot must not take the endpoint down for
					// 24 hours: sign with the current secret only.
					if (!isSecretError(error)) throw error;
					previous = null;
					previousExpiresAt = null;
				}
			}
		}
		return { current, previous, source: 'db', previousExpiresAt };
	}
	const legacy = await readLegacySecret(db, webhookId);
	if (legacy) {
		return { current: legacy, previous: null, source: 'legacy', previousExpiresAt: null };
	}
	throw new SecretError('missing', 'No signing secret configured for this webhook endpoint');
}

export interface WebhookSecretStatus {
	configured: boolean;
	hint: string | null;
	updatedAt: Date | null;
	previousExpiresAt: Date | null;
}

/** Presence and hint for the admin UI; never the ciphertext or the value. */
export async function readWebhookSecretStatuses(
	db: SecretDb,
	webhookIds: readonly string[]
): Promise<Map<string, WebhookSecretStatus>> {
	const out = new Map<string, WebhookSecretStatus>();
	if (webhookIds.length === 0) return out;
	try {
		const rows = await db
			.select<{
				webhookId: string;
				hint: string;
				updatedAt: Date;
				previousExpiresAt: Date | null;
			}>({
				webhookId: webhookSecrets.webhookId,
				hint: webhookSecrets.hint,
				updatedAt: webhookSecrets.updatedAt,
				previousExpiresAt: webhookSecrets.previousExpiresAt
			})
			.from(webhookSecrets)
			.where(inArray(webhookSecrets.webhookId, [...webhookIds]));
		for (const row of rows) {
			out.set(row.webhookId, {
				configured: true,
				hint: row.hint,
				updatedAt: row.updatedAt,
				previousExpiresAt: row.previousExpiresAt
			});
		}
	} catch {
		// Display only; the delivery path still fails closed.
	}
	return out;
}

export interface EncryptedWebhookSecret {
	ciphertext: string;
	hint: string;
	keyVersion: number;
}

/** Encrypt a new signing secret with the active key version and row AAD. */
export function encryptWebhookSecretValue(
	webhookId: string,
	value: string,
	keyring: ReturnType<typeof loadKeyring>
): EncryptedWebhookSecret {
	const key = keyring.resolve(keyring.activeVersion);
	if (!key) {
		throw new SecretError(
			'store_unavailable',
			`Active key version ${keyring.activeVersion} is not present in the keyring`
		);
	}
	return {
		ciphertext: encryptSecret(
			value,
			key,
			keyring.activeVersion,
			secretAad('webhook_secrets', webhookId, 'ciphertext')
		),
		hint: maskWebhookSecret(value),
		keyVersion: keyring.activeVersion
	};
}

/** Encrypt a value that will live in `previous_ciphertext` (rotation grace). */
export function encryptPreviousWebhookSecret(
	webhookId: string,
	value: string,
	keyring: ReturnType<typeof loadKeyring>
): { ciphertext: string; keyVersion: number } {
	const key = keyring.resolve(keyring.activeVersion);
	if (!key) {
		throw new SecretError(
			'store_unavailable',
			`Active key version ${keyring.activeVersion} is not present in the keyring`
		);
	}
	return {
		ciphertext: encryptSecret(
			value,
			key,
			keyring.activeVersion,
			secretAad('webhook_secrets', webhookId, 'previous_ciphertext')
		),
		keyVersion: keyring.activeVersion
	};
}

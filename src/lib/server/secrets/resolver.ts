import { eq, inArray } from 'drizzle-orm';
import { aiProviderSecrets } from '../db/ai/ai-provider-secret.schema.ts';
import { decryptSecret, encryptSecret, secretAad } from './crypto.ts';
import { SecretError } from './errors.ts';
import { KeyringConfigError, keyringFromEnv, type SecretKeyring } from './keyring.ts';

/**
 * Call-time resolver for runtime AI provider keys (W2.4, decision D0-C).
 *
 * Read order, evaluated on EVERY call (no process cache: a cache would need
 * invalidation, and multi-replica invalidation is where the bugs live):
 *
 *     ai_provider_secrets.ciphertext  >  api_key_env  >  missing
 *
 * Only `missing` may fall back to the environment. `decrypt_failed`,
 * `unknown_key_version` and `store_unavailable` are terminal - the resolver
 * never tries another key, another provider or another source, because a wrong
 * master key must be visible instead of quietly billing another account.
 *
 * No `$lib`/`$env` imports: the job drain loads this under plain Node. The env
 * lookup is injected; key material is never logged.
 */

/**
 * Structural DB seam (same pattern as `audit.ts`): the resolver only needs
 * `select`, and both the app db and a transaction satisfy it. Call sites cast
 * the drizzle client once (`db as unknown as SecretDb`) because the schema
 * generic is not part of this contract.
 */
interface SelectWhere<T> {
	/** Awaitable directly (status lists) and `.limit(n)` for a single row. */
	where(condition: unknown): Promise<T[]> & { limit(count: number): Promise<T[]> };
}
interface SelectFrom<T> {
	from(table: unknown): SelectWhere<T>;
}
export interface SecretDb {
	select<T = Record<string, unknown>>(fields?: Record<string, unknown>): SelectFrom<T>;
}

export interface ProviderKeyRef {
	/** Provider row id; absent on an unsaved form, which means "env only". */
	id?: string | null;
	apiKeyEnv?: string | null;
}

export interface ResolvedProviderKey {
	value: string;
	source: 'db' | 'env';
	/** Display fragment for DB rows; null for env sources. */
	hint: string | null;
	keyVersion: number | null;
}

export interface ResolveDeps {
	getEnv: (name: string) => string | undefined;
	/** Test seam; production always parses the keyring from `getEnv`. */
	keyring?: SecretKeyring;
}

interface ProviderSecretRow {
	ciphertext: string;
	hint: string;
	keyVersion: number;
	updatedAt: Date;
}

/** Load the keyring, mapping a missing/malformed configuration to a typed failure. */
export function loadKeyring(deps: Pick<ResolveDeps, 'getEnv' | 'keyring'>): SecretKeyring {
	if (deps.keyring) return deps.keyring;
	try {
		return keyringFromEnv(deps.getEnv);
	} catch (error) {
		if (error instanceof KeyringConfigError) {
			// The message never contains key material (keyring.test.ts pins it).
			throw new SecretError(
				'store_unavailable',
				error.reason === 'not_configured'
					? 'SECRETS_KEYS is not configured; cannot read DB secrets'
					: `SECRETS keyring is invalid: ${error.message}`
			);
		}
		throw error;
	}
}

async function readProviderSecretRow(
	db: SecretDb,
	providerId: string
): Promise<ProviderSecretRow | null> {
	try {
		const rows = await db
			.select<ProviderSecretRow>({
				ciphertext: aiProviderSecrets.ciphertext,
				hint: aiProviderSecrets.hint,
				keyVersion: aiProviderSecrets.keyVersion,
				updatedAt: aiProviderSecrets.updatedAt
			})
			.from(aiProviderSecrets)
			.where(eq(aiProviderSecrets.providerId, providerId))
			.limit(1);
		return rows[0] ?? null;
	} catch (error) {
		// A missing table (migration not applied), a closed pool or a permission
		// error must not be reinterpreted as "no key configured".
		throw new SecretError('store_unavailable', `Secret store unavailable: ${errorText(error)}`);
	}
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Resolve the key for one provider. Throws `SecretError`; callers map it to
 * their own typed error (the AI runtime maps to `AiError`).
 *
 * A provider without an id (unsaved dialog) skips the DB read: there is no row
 * it could own, and querying with a fabricated id would be a bug.
 */
export async function resolveProviderKey(
	db: SecretDb,
	provider: ProviderKeyRef,
	deps: ResolveDeps
): Promise<ResolvedProviderKey> {
	const providerId = provider.id ?? null;
	if (providerId) {
		const row = await readProviderSecretRow(db, providerId);
		if (row) {
			const keyring = loadKeyring(deps);
			const aad = secretAad('ai_provider_secrets', providerId, 'ciphertext');
			const { plaintext } = decryptSecret(row.ciphertext, keyring.resolve, aad);
			return {
				value: plaintext,
				source: 'db',
				hint: row.hint,
				keyVersion: row.keyVersion
			};
		}
	}
	const envName = provider.apiKeyEnv?.trim();
	if (envName) {
		const value = deps.getEnv(envName);
		if (value !== undefined && value !== '') {
			return { value, source: 'env', hint: null, keyVersion: null };
		}
	}
	throw new SecretError(
		'missing',
		envName ? `No key for provider (${envName} is not set)` : 'No key configured for provider'
	);
}

export interface ProviderKeyStatus {
	configured: boolean;
	hint: string | null;
	keyVersion: number | null;
	updatedAt: Date | null;
}

/**
 * Status for the admin UI: presence and hint only, never the ciphertext or the
 * value. A store failure degrades the badge (all unconfigured) instead of
 * 500ing the page - the read path still fails closed.
 */
export async function readProviderKeyStatuses(
	db: SecretDb,
	providerIds: readonly string[]
): Promise<Map<string, ProviderKeyStatus>> {
	const out = new Map<string, ProviderKeyStatus>();
	if (providerIds.length === 0) return out;
	try {
		const rows = await db
			.select<{
				providerId: string;
				hint: string;
				keyVersion: number;
				updatedAt: Date;
			}>({
				providerId: aiProviderSecrets.providerId,
				hint: aiProviderSecrets.hint,
				keyVersion: aiProviderSecrets.keyVersion,
				updatedAt: aiProviderSecrets.updatedAt
			})
			.from(aiProviderSecrets)
			.where(inArray(aiProviderSecrets.providerId, [...providerIds]));
		for (const row of rows) {
			out.set(row.providerId, {
				configured: true,
				hint: row.hint,
				keyVersion: row.keyVersion,
				updatedAt: row.updatedAt
			});
		}
	} catch {
		// Display only: never leak a store error into page data.
	}
	return out;
}

/**
 * Env names whose provider already has a DB-managed key. Readiness surfaces
 * consume it as an extra "present" signal so a configured DB key does not show
 * as `missing_env` (`ai-readiness.ts` stays env-shaped to avoid a data query
 * inside a pure module).
 */
export async function envNamesWithDatabaseKeys(
	db: SecretDb,
	providers: ReadonlyArray<{ id: string; apiKeyEnv: string | null }>
): Promise<Set<string>> {
	const ids = providers.map((provider) => provider.id);
	const statuses = await readProviderKeyStatuses(db, ids);
	const names = new Set<string>();
	for (const provider of providers) {
		if (provider.apiKeyEnv && statuses.get(provider.id)?.configured) {
			names.add(provider.apiKeyEnv);
		}
	}
	return names;
}

/**
 * Display hint: a recognizable prefix and the last four characters, never the
 * value. Short values reveal less: a 9-character key must not show 8 of its
 * characters in a badge or an audit payload.
 */
export function providerKeyHint(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 12) {
		return trimmed.length > 2 ? `\u2026${trimmed.slice(-2)}` : '\u2026';
	}
	if (trimmed.length <= 16) {
		return `\u2026${trimmed.slice(-4)}`;
	}
	const prefix = trimmed.startsWith('sk-') ? 'sk-' : trimmed.slice(0, 4);
	return `${prefix}\u2026${trimmed.slice(-4)}`;
}

export interface EncryptedProviderKey {
	ciphertext: string;
	hint: string;
	keyVersion: number;
}

/** Encrypt a provider key with the active key version and the row-bound AAD. */
export function encryptProviderKeyValue(
	providerId: string,
	value: string,
	keyring: SecretKeyring
): EncryptedProviderKey {
	const key = keyring.resolve(keyring.activeVersion);
	if (!key) {
		throw new SecretError(
			'store_unavailable',
			`Active key version ${keyring.activeVersion} is not present in the keyring`
		);
	}
	const ciphertext = encryptSecret(
		value,
		key,
		keyring.activeVersion,
		secretAad('ai_provider_secrets', providerId, 'ciphertext')
	);
	return { ciphertext, hint: providerKeyHint(value), keyVersion: keyring.activeVersion };
}

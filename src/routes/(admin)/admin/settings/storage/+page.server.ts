import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { m } from '$lib/paraglide/messages';
import { db } from '$lib/server/db';
import { files } from '$lib/server/db/content';
import { recordActivity } from '$lib/server/audit';
import { requireAdminRole } from '$lib/server/authz';
import { getOption, setOption } from '$lib/server/config/options-registry';
import { assertSettingWrite, settingAccess } from '$lib/server/settings/tiers';
import {
	STORAGE_PROVIDER_TYPES,
	driverLabel,
	providerConfigSchema,
	providerFingerprint,
	type StorageProviderConfig
} from '$lib/server/storage/provider';
import { S3_CREDENTIAL_ENV } from '$lib/server/storage/config';
import { buildStorageForProvider, storageCredentials } from '$lib/server/storage';
import { sanitizeProviderError } from '$lib/server/settings/provider-status';
import {
	StorageCredentialError,
	clearStorageCredentials,
	readStorageCredentialStatus,
	saveStorageCredentials
} from '$lib/server/secrets/storage-credentials';
import {
	StorageEndpointError,
	allowPrivateEndpoint,
	assertStorageEndpointAllowed
} from '$lib/server/storage/endpoint-guard';
import { probeStorage } from '$lib/server/storage/probe';
import type { StorageProbeResult } from '$lib/server/storage/probe';
import type { StorageStatusState } from '$lib/server/storage/provider';
import { readDatabaseStatus, readJournal } from '$lib/server/storage/db-status';
import { sql } from 'drizzle-orm';

/**
 * Storage control plane (W7.2, decisions ST1/ST3/ST4/ST8/Q4).
 *
 * Six sections: the live provider (read-only), the saved candidate (owner),
 * credentials (env references today), migration/cutover (CLI, with the real
 * `files` count), media purge TTLs (owner) and the read-only capability map.
 *
 * Two truths, deliberately:
 *   `storage.provider` — the form target. Saving writes ONLY this row.
 *   `storage.active`   — what the app actually reads. Written by an activation
 *                        path (empty files table, or `storage:migrate
 *                        --cutover`), never by a form submit.
 *
 * Secrets never reach this module: the page shows env VAR NAMES, and the
 * config schema has no credential field at all (decision Q3/Q15).
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const [provider, active, status, migration, purge, fileCount] = await Promise.all([
		getOption('storage.provider'),
		getOption('storage.active'),
		getOption('storage.status'),
		getOption('storage.migration'),
		getOption('media.purge'),
		db.$count(files)
	]);
	const role = event.locals.admin?.role;
	const access = settingAccess(role, 'storage');

	// The live addressing for the local driver comes from RUSTFS_*, never from
	// the option row (the candidate stores null for local, by schema).
	const activeEndpoint =
		active.config.driver === 'local'
			? (env.RUSTFS_ENDPOINT?.trim() ?? null)
			: active.config.endpoint;
	const activeBucket =
		active.config.driver === 'local' ? (env.RUSTFS_BUCKET?.trim() ?? null) : active.config.bucket;
	const credentialStatus = await readStorageCredentialStatus(db as never, {
		getEnv: (name) => env[name]
	});

	// Read-only database facts (W7.7/Q17): mode, masked host, migration ledger.
	// `db.execute` on the app handle is the same connection the page just used,
	// so a failure here means the ledger table is missing, not that the DB is
	// down — readDatabaseStatus degrades instead of throwing.
	const database = await readDatabaseStatus({
		url: env.DATABASE_URL,
		journal: readJournal(),
		readLedger: async () => {
			const rows = (await db.execute(sql`
				select count(*)::int as applied, max(created_at) as latest
				from drizzle.__drizzle_migrations
			`)) as unknown as Array<{ applied: number; latest: string | number | null }>;
			const row = rows[0];
			return {
				applied: row?.applied ?? 0,
				latestMs: row?.latest === null || row?.latest === undefined ? null : Number(row.latest)
			};
		}
	});

	return {
		provider,
		providerTypes: [...STORAGE_PROVIDER_TYPES],
		active: {
			config: active.config,
			label: driverLabel(active.config),
			endpoint: activeEndpoint,
			bucket: activeBucket,
			activatedAt: active.activatedAt,
			previous: active.previous,
			fingerprint: providerFingerprint(active.config)
		},
		status,
		migration: {
			state: migration.state,
			total: migration.total,
			verified: migration.verified,
			failed: migration.failed,
			startedAt: migration.startedAt,
			cutoverAt: migration.cutoverAt,
			error: migration.error
		},
		purge,
		fileCount,
		migrationRequired: fileCount > 0,
		migrationRunning: migration.state === 'copying',
		credentials: {
			source: credentialStatus.source,
			accessHint: credentialStatus.accessHint,
			secretHint: credentialStatus.secretHint,
			keyVersion: credentialStatus.keyVersion,
			updatedAt: credentialStatus.updatedAt?.toISOString() ?? null,
			envNames: S3_CREDENTIAL_ENV
		},
		database,
		// Env references the local driver reads (names + presence only).
		envRefs: {
			endpoint: env.RUSTFS_ENDPOINT?.trim() ? ('set' as const) : ('missing' as const),
			bucket: env.RUSTFS_BUCKET?.trim() ? ('set' as const) : ('missing' as const),
			accessKey: env.RUSTFS_ACCESS_KEY?.trim() ? ('set' as const) : ('missing' as const),
			secretKey: env.RUSTFS_SECRET_KEY?.trim() ? ('set' as const) : ('missing' as const)
		},
		editable: access.editable,
		ownerOnly: !access.editable,
		allowPrivateEndpoint: allowPrivateEndpoint(env),
		// A stored probe result is only meaningful for the config it covered.
		statusMatchesActive:
			status.fingerprint === null || status.fingerprint === providerFingerprint(active.config)
	};
};

function stringField(form: FormData, name: string): string {
	return (form.get(name) ?? '').toString().trim();
}

/**
 * Parses the provider form into the option shape. A local driver deliberately
 * nulls endpoint/bucket/providerType — the schema rejects a local provider that
 * carries external addressing, so a stale form post cannot smuggle one in.
 */
function providerFromForm(form: FormData): StorageProviderConfig {
	const driver = form.get('driver') === 's3' ? 's3' : 'local';
	const providerType = stringField(form, 'providerType');
	const endpoint = stringField(form, 'endpoint');
	const bucket = stringField(form, 'bucket');
	const publicBaseUrl = stringField(form, 'publicBaseUrl');
	const region = stringField(form, 'region');
	const deleteMode =
		form.get('deleteMode') === 'logical' ? ('logical' as const) : ('hard' as const);
	if (driver === 'local') {
		return {
			driver: 'local',
			providerType: null,
			endpoint: null,
			region: region || 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: publicBaseUrl === '' ? null : publicBaseUrl,
			deleteMode
		};
	}
	return {
		driver: 's3',
		providerType: (providerType || null) as StorageProviderConfig['providerType'],
		endpoint: endpoint === '' ? null : endpoint,
		region: region || 'us-east-1',
		bucket: bucket === '' ? null : bucket,
		forcePathStyle: form.get('forcePathStyle') === 'on' || form.get('forcePathStyle') === 'true',
		publicBaseUrl: publicBaseUrl === '' ? null : publicBaseUrl,
		deleteMode
	};
}

/** Maps the first schema issue to a localized field message. */
function configErrorMessage(config: StorageProviderConfig): string {
	const parsed = providerConfigSchema.safeParse(config);
	if (parsed.success) return '';
	const issue = parsed.error.issues[0];
	switch (issue?.path[0]) {
		case 'endpoint':
			return m.admin_settings_storage_err_endpoint();
		case 'bucket':
			return m.admin_settings_storage_err_bucket();
		case 'providerType':
			return m.admin_settings_storage_err_provider_type();
		case 'region':
			return m.admin_settings_storage_err_region();
		case 'publicBaseUrl':
			return m.admin_settings_storage_err_public_base_url();
		default:
			return issue?.message ?? m.admin_settings_storage_err_config();
	}
}

/** Maps the SSRF guard's closed failure codes to readable form errors. */
function endpointErrorMessage(error: unknown): string {
	if (error instanceof StorageEndpointError) {
		if (error.code === 'private') return m.admin_settings_storage_err_endpoint_private();
		if (error.code === 'metadata') return m.admin_settings_storage_err_endpoint_metadata();
		if (error.code === 'resolve') return m.admin_settings_storage_err_endpoint_resolve();
		return m.admin_settings_storage_err_endpoint();
	}
	// Anything else here is an unusable configuration (missing credentials, an
	// incomplete provider): sanitize and show it, since it names env vars only.
	return sanitizeProviderError(error);
}

/** Localized probe outcome; the sanitized detail follows when there is one. */
function probeMessage(result: StorageProbeResult): string {
	const label =
		result.status === 'auth'
			? m.admin_settings_storage_test_auth()
			: result.status === 'not-found'
				? m.admin_settings_storage_test_not_found()
				: result.status === 'timeout'
					? m.admin_settings_storage_test_timeout()
					: result.status === 'network'
						? m.admin_settings_storage_test_network()
						: result.status === 'write'
							? m.admin_settings_storage_test_write()
							: result.status === 'capability'
								? m.admin_settings_storage_test_capability()
								: m.admin_settings_storage_test_failed();
	return result.message ? `${label} — ${result.message}` : label;
}

export const actions: Actions = {
	/**
	 * Save the CANDIDATE only (decision Q4). `storage.active` is untouched on
	 * purpose: with media on disk the switch needs a migration, and even on an
	 * empty install it must be an explicit activation, not a form submit.
	 */
	saveProvider: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'storage', 'storage.provider');

		const form = await event.request.formData();
		const before = await getOption('storage.provider');
		const candidate = providerFromForm(form);
		const errorMessage = configErrorMessage(candidate);
		if (errorMessage) {
			return fail(400, { step: 'provider' as const, ok: false, message: errorMessage });
		}
		const parsed = providerConfigSchema.parse(candidate);

		// SSRF policy (W7.3/Q19): the saved endpoint is what the runtime will
		// use, so it is validated here (https, no credentials, public DNS unless
		// the operator opted into a LAN endpoint, never a metadata address).
		if (parsed.driver === 's3') {
			try {
				await assertStorageEndpointAllowed(parsed.endpoint!, {
					allowPrivate: allowPrivateEndpoint(env)
				});
			} catch (caught) {
				return fail(400, {
					step: 'provider' as const,
					ok: false,
					message: endpointErrorMessage(caught)
				});
			}
		}

		await setOption('storage.provider', parsed);
		await recordActivity(db, {
			event: 'storage.provider_update',
			actorId: event.locals.user?.id ?? null,
			payload: {
				fields: [
					'driver',
					'provider_type',
					'endpoint',
					'region',
					'bucket',
					'path_style',
					'public_base_url'
				],
				before,
				after: parsed
			},
			// Endpoint/hostnames stay local: an outbound webhook payload is not
			// an operations console (same rule as the profile events).
			deliver: false
		});

		return {
			step: 'provider' as const,
			ok: true,
			message: m.admin_settings_storage_saved_inactive()
		};
	},

	/**
	 * Connection probe (W7.3, decision Q19). Probes the SAVED candidate with the
	 * configured credentials: HeadBucket, bucket capabilities, then a
	 * Put/Get/Delete roundtrip under `probe/`. The result is stored sanitized
	 * and audited; a successful probe is NOT an activation (Q4).
	 */
	testProvider: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'storage', 'storage.provider');

		const provider = await getOption('storage.provider');
		const fingerprint = providerFingerprint(provider);
		const previous = await getOption('storage.status');
		let result: StorageProbeResult | null = null;
		let failureMessage = '';

		try {
			// Defence in depth: the endpoint was checked at save time, but the
			// probe is the one place that actually dials a candidate.
			if (provider.driver === 's3') {
				await assertStorageEndpointAllowed(provider.endpoint!, {
					allowPrivate: allowPrivateEndpoint(env)
				});
			}
			const storage = buildStorageForProvider(provider, {
				source: env,
				credentials: provider.driver === 'local' ? null : await storageCredentials(),
				// A probe must answer quickly; an unreachable endpoint is a
				// result, not a hung request.
				headersTimeoutMs: 10_000
			});
			result = await probeStorage(storage);
		} catch (caught) {
			failureMessage = endpointErrorMessage(caught);
		}

		const status: StorageStatusState = result
			? {
					lastTestAt: result.checkedAt,
					lastTestOk: result.ok,
					lastError: result.message ? sanitizeProviderError(result.message) : null,
					lastStatus: result.status,
					bucketVersioning: result.versioning,
					objectLock: result.objectLock,
					fingerprint
				}
			: {
					...previous,
					lastTestAt: new Date().toISOString(),
					lastTestOk: false,
					lastError: sanitizeProviderError(failureMessage),
					lastStatus: 'unknown',
					fingerprint
				};

		await setOption('storage.status', status);
		await recordActivity(db, {
			event: 'storage.test',
			actorId: event.locals.user?.id ?? null,
			payload: {
				ok: status.lastTestOk,
				status: status.lastStatus,
				fingerprint,
				versioning: status.bucketVersioning,
				object_lock: status.objectLock
			},
			deliver: false
		});

		if (!result) {
			return fail(400, { step: 'test' as const, ok: false, message: failureMessage });
		}
		if (!result.ok) {
			return fail(502, { step: 'test' as const, ok: false, message: probeMessage(result) });
		}
		return { step: 'test' as const, ok: true, message: m.admin_settings_storage_test_ok() };
	},

	/** Purge TTLs (W7.2/ST10): floor 1 day, unit days, saving deletes nothing. */
	savePurge: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'storage', 'storage.purge');

		const form = await event.request.formData();
		const pendingDays = Number(stringField(form, 'pendingDays'));
		const detachedDays = Number(stringField(form, 'detachedDays'));
		if (!Number.isInteger(pendingDays) || pendingDays < 1) {
			return fail(400, {
				step: 'purge' as const,
				ok: false,
				message: m.admin_settings_storage_err_purge_days()
			});
		}
		if (!Number.isInteger(detachedDays) || detachedDays < 1) {
			return fail(400, {
				step: 'purge' as const,
				ok: false,
				message: m.admin_settings_storage_err_purge_days()
			});
		}

		const before = await getOption('media.purge');
		await setOption('media.purge', { pendingDays, detachedDays });
		await recordActivity(db, {
			event: 'storage.update',
			actorId: event.locals.user?.id ?? null,
			payload: {
				fields: ['pending_days', 'detached_days'],
				before,
				after: { pendingDays, detachedDays }
			},
			deliver: false
		});

		return {
			step: 'purge' as const,
			ok: true,
			message: m.admin_settings_storage_purge_saved()
		};
	},

	/**
	 * Write-only credential replacement (W7.6/Q3). The posted values are
	 * encrypted immediately; the response, the audit row and the reloaded page
	 * carry hints only. Owner-only (storage.credentials tier).
	 */
	saveCredentials: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'storage', 'storage.credentials');

		const form = await event.request.formData();
		try {
			const { keyVersion } = await saveStorageCredentials(
				db as never,
				{
					accessKeyId: stringField(form, 'accessKeyId'),
					secretAccessKey: stringField(form, 'secretAccessKey')
				},
				{
					actorId: event.locals.user?.id ?? null,
					deps: { getEnv: (name) => env[name] }
				}
			);
			await recordActivity(db, {
				event: 'storage.update',
				actorId: event.locals.user?.id ?? null,
				// Hints/values never enter the audit payload; the key version and
				// the action are what an operator needs to see later.
				payload: {
					fields: ['storage_credentials'],
					action: 'credentials_set',
					key_version: keyVersion
				},
				deliver: false
			});
			return {
				step: 'credentials' as const,
				ok: true,
				message: m.admin_settings_storage_credentials_saved()
			};
		} catch (caught) {
			if (caught instanceof StorageCredentialError) {
				return fail(400, {
					step: 'credentials' as const,
					ok: false,
					message:
						caught.reason === 'missing'
							? m.admin_settings_storage_err_credentials_missing()
							: m.admin_settings_storage_err_credentials_shape()
				});
			}
			// Name only: a crypto/keyring message may name a key version but must
			// never echo a value, and neither belongs in the response.
			console.warn(
				'[settings] storage credentials save failed',
				caught instanceof Error ? caught.name : typeof caught
			);
			return fail(503, {
				step: 'credentials' as const,
				ok: false,
				message: m.admin_settings_storage_credentials_store_unavailable()
			});
		}
	},

	/** Remove the stored pair; the environment fallback becomes active again. */
	clearCredentials: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'storage', 'storage.credentials');

		try {
			await clearStorageCredentials(db as never);
		} catch (caught) {
			console.warn(
				'[settings] storage credentials clear failed',
				caught instanceof Error ? caught.name : typeof caught
			);
			return fail(503, {
				step: 'credentials' as const,
				ok: false,
				message: m.admin_settings_storage_credentials_store_unavailable()
			});
		}
		await recordActivity(db, {
			event: 'storage.update',
			actorId: event.locals.user?.id ?? null,
			payload: { fields: ['storage_credentials'], action: 'credentials_clear' },
			deliver: false
		});
		return {
			step: 'credentials' as const,
			ok: true,
			message: m.admin_settings_storage_credentials_cleared()
		};
	}
};

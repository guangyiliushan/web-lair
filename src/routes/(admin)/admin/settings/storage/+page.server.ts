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
import { S3_CREDENTIAL_ENV, providerCredentialsFromEnv } from '$lib/server/storage/config';

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
	const [provider, active, status, purge, fileCount] = await Promise.all([
		getOption('storage.provider'),
		getOption('storage.active'),
		getOption('storage.status'),
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
	const credentials = providerCredentialsFromEnv(env);

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
		purge,
		fileCount,
		migrationRequired: fileCount > 0,
		credentials: {
			source: credentials ? ('env' as const) : ('missing' as const),
			envNames: S3_CREDENTIAL_ENV
		},
		// Env references the local driver reads (names + presence only).
		envRefs: {
			endpoint: env.RUSTFS_ENDPOINT?.trim() ? ('set' as const) : ('missing' as const),
			bucket: env.RUSTFS_BUCKET?.trim() ? ('set' as const) : ('missing' as const),
			accessKey: env.RUSTFS_ACCESS_KEY?.trim() ? ('set' as const) : ('missing' as const),
			secretKey: env.RUSTFS_SECRET_KEY?.trim() ? ('set' as const) : ('missing' as const)
		},
		editable: access.editable,
		ownerOnly: !access.editable,
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
export function providerFromForm(form: FormData): StorageProviderConfig {
	const driver = form.get('driver') === 's3' ? 's3' : 'local';
	const providerType = stringField(form, 'providerType');
	const endpoint = stringField(form, 'endpoint');
	const bucket = stringField(form, 'bucket');
	const publicBaseUrl = stringField(form, 'publicBaseUrl');
	const region = stringField(form, 'region');
	if (driver === 'local') {
		return {
			driver: 'local',
			providerType: null,
			endpoint: null,
			region: region || 'us-east-1',
			bucket: null,
			forcePathStyle: true,
			publicBaseUrl: publicBaseUrl === '' ? null : publicBaseUrl
		};
	}
	return {
		driver: 's3',
		providerType: (providerType || null) as StorageProviderConfig['providerType'],
		endpoint: endpoint === '' ? null : endpoint,
		region: region || 'us-east-1',
		bucket: bucket === '' ? null : bucket,
		forcePathStyle: form.get('forcePathStyle') === 'on' || form.get('forcePathStyle') === 'true',
		publicBaseUrl: publicBaseUrl === '' ? null : publicBaseUrl
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
	}
};

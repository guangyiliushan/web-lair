import { z } from 'zod';

/**
 * Storage provider model (W7.2, decisions ST4/ST8/Q1/Q4/Q19).
 *
 * `storage.provider` is the SAVED candidate — a form target that never takes
 * effect by itself. The live target is `storage.active.config`, written only
 * by an activation path (first activation with an empty `files` table, or
 * `storage:migrate --cutover`). Saving therefore cannot switch a running site
 * onto a half-configured bucket (decision Q4: "禁止 Save 即切").
 *
 * The shape is deliberately small: driver + addressing + bucket, no `keyPrefix`
 * and no parallel "backup S3"/"comment prefix" fields (ST8). Credentials never
 * live here — they are env references today and envelopes in the secret store
 * once W7.6 lands (decision Q3/Q15); an option row is loaded wholesale and
 * would leak a key into page data.
 */

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

export const STORAGE_PROVIDER_TYPES = [
	'aws-s3',
	'r2',
	'minio',
	'b2',
	'wasabi',
	'spaces',
	'custom'
] as const;
export type StorageProviderType = (typeof STORAGE_PROVIDER_TYPES)[number];

/** R2 signs with `region=auto` and rejects anything else. */
export const R2_REGION = 'auto';
export const DEFAULT_S3_REGION = 'us-east-1';

/**
 * S3 bucket naming rules (AWS "bucket naming rules"): lowercase letters,
 * digits, dots and hyphens, 3-63 characters, no leading/trailing dot or
 * hyphen, not an IP address. Enforced at save so an invalid name fails in the
 * form, not on the first upload.
 */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

export function isBucketName(value: string): boolean {
	if (!BUCKET_PATTERN.test(value)) return false;
	if (IPV4_PATTERN.test(value)) return false;
	if (value.includes('..')) return false;
	return !value.startsWith('xn--');
}

/** An https URL with no embedded credentials (Q19: no URL credentials). */
export function isPublicHttpsUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	return url.protocol === 'https:' && !url.username && !url.password;
}

const optionalHttpsUrl = z
	.string()
	.trim()
	.max(2048)
	.refine((value) => value === '' || isPublicHttpsUrl(value), {
		error: () => 'Must be an https URL without credentials'
	})
	.nullable();

export const providerConfigSchema = z
	.object({
		driver: z.enum(STORAGE_DRIVERS),
		/** Only meaningful for `driver=s3`; null for the bundled RustFS. */
		providerType: z.enum(STORAGE_PROVIDER_TYPES).nullable(),
		/** External endpoint (https). The local driver reads RUSTFS_ENDPOINT. */
		endpoint: z.string().trim().max(2048).nullable(),
		region: z.string().trim().min(1).max(64),
		/** External bucket name. The local driver reads RUSTFS_BUCKET. */
		bucket: z.string().trim().max(63).nullable(),
		forcePathStyle: z.boolean(),
		/** Optional CDN alias; the default stays the private `/i` proxy (Q9/Q12). */
		publicBaseUrl: optionalHttpsUrl,
		/**
		 * Deletion contract (W7.5, decision Q8/Q16): `hard` is the normal mode
		 * and is only allowed on a bucket whose versioning and object lock are
		 * off. `logical` is the explicit opt-in for a versioned / locked bucket:
		 * deletes still issue DELETE (a delete marker appears), the media stops
		 * being served, and the bytes are NOT reclaimed — the operator says so
		 * on purpose instead of discovering it during a purge.
		 */
		deleteMode: z.enum(['hard', 'logical']).default('hard')
	})
	.superRefine((value, ctx) => {
		if (value.driver === 'local') {
			if (value.providerType !== null) {
				ctx.addIssue({
					code: 'custom',
					path: ['providerType'],
					message: 'The local driver has no provider type'
				});
			}
			// Endpoint/bucket stay null: they come from RUSTFS_* env.
			if (value.endpoint !== null || value.bucket !== null) {
				ctx.addIssue({
					code: 'custom',
					path: ['endpoint'],
					message: 'The local driver reads its endpoint and bucket from the environment'
				});
			}
			return;
		}

		if (!value.providerType) {
			ctx.addIssue({
				code: 'custom',
				path: ['providerType'],
				message: 'Choose a provider type'
			});
		}
		if (!value.endpoint || !isPublicHttpsUrl(value.endpoint)) {
			ctx.addIssue({
				code: 'custom',
				path: ['endpoint'],
				message: 'An external endpoint must be an https URL without credentials'
			});
		}
		if (!value.bucket || !isBucketName(value.bucket)) {
			ctx.addIssue({
				code: 'custom',
				path: ['bucket'],
				message: 'Bucket names are 3-63 lowercase letters, digits, dots or hyphens'
			});
		}
		if (value.providerType === 'r2' && value.region !== R2_REGION) {
			ctx.addIssue({
				code: 'custom',
				path: ['region'],
				message: `Cloudflare R2 requires region "${R2_REGION}"`
			});
		}
	});

export type StorageProviderConfig = z.infer<typeof providerConfigSchema>;

/** Bootstrap state: the bundled RustFS, addressed from RUSTFS_* env. */
export const DEFAULT_PROVIDER_CONFIG: StorageProviderConfig = {
	driver: 'local',
	providerType: null,
	endpoint: null,
	region: DEFAULT_S3_REGION,
	bucket: null,
	forcePathStyle: true,
	publicBaseUrl: null,
	deleteMode: 'hard'
};

/**
 * The live target plus its rollback slot. `previous` is written on cutover so
 * `storage:migrate --rollback` has a target even after the candidate form was
 * edited again (decision Q13).
 */
export const storageActiveSchema = z.object({
	config: providerConfigSchema,
	previous: providerConfigSchema.nullable(),
	activatedAt: z.string().nullable(),
	activatedBy: z.string().nullable()
});

export type StorageActive = z.infer<typeof storageActiveSchema>;

export const DEFAULT_STORAGE_ACTIVE: StorageActive = {
	config: DEFAULT_PROVIDER_CONFIG,
	previous: null,
	activatedAt: null,
	activatedBy: null
};

/**
 * Last probe result (W7.3/W7.5). Never carries a URL, a key or a driver
 * message: `lastError` is sanitized before it is stored.
 */
export const storageStatusSchema = z.object({
	lastTestAt: z.string().nullable(),
	lastTestOk: z.boolean().nullable(),
	lastError: z.string().max(300).nullable(),
	/** Closed status code of the last probe (W7.3); the page localizes it. */
	lastStatus: z
		.enum(['ok', 'auth', 'not-found', 'timeout', 'network', 'write', 'capability', 'unknown'])
		.nullable()
		.default(null),
	/** Bucket versioning at probe time; `unknown` blocks a hard-delete switch. */
	bucketVersioning: z.enum(['off', 'enabled', 'suspended', 'unknown']).nullable(),
	objectLock: z.boolean().nullable(),
	/** Which provider config the probe covered (see providerFingerprint). */
	fingerprint: z.string().nullable()
});

export type StorageStatusState = z.infer<typeof storageStatusSchema>;

export const DEFAULT_STORAGE_STATUS: StorageStatusState = {
	lastTestAt: null,
	lastTestOk: null,
	lastError: null,
	lastStatus: null,
	bucketVersioning: null,
	objectLock: null,
	fingerprint: null
};

/**
 * Migration bookkeeping (W7.4, decision Q13): a CLI-only copy with a
 * maintenance window, persisted so the app can freeze uploads / refuse purge
 * while it runs and so a crashed run is visible instead of silent.
 */
export const storageMigrationSchema = z.object({
	state: z.enum(['idle', 'copying', 'copied', 'failed', 'cutover', 'rolled-back']),
	/** Run id (uuid) of the last attempt; null before the first run. */
	id: z.string().nullable(),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	cutoverAt: z.string().nullable(),
	/** Fingerprints of the source/target provider snapshots. */
	sourceFingerprint: z.string().nullable(),
	targetFingerprint: z.string().nullable(),
	/** Objects planned (canonical files + their variants). */
	total: z.number().int().nonnegative(),
	copied: z.number().int().nonnegative(),
	verified: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
	/** Sanitized reason of the last failure. */
	error: z.string().max(300).nullable()
});

export type StorageMigrationState = z.infer<typeof storageMigrationSchema>;

export const DEFAULT_STORAGE_MIGRATION: StorageMigrationState = {
	state: 'idle',
	id: null,
	startedAt: null,
	finishedAt: null,
	cutoverAt: null,
	sourceFingerprint: null,
	targetFingerprint: null,
	total: 0,
	copied: 0,
	verified: 0,
	failed: 0,
	bytes: 0,
	error: null
};

/** True while a copy is running (uploads freeze, purge refuses). */
export function migrationInProgress(state: Pick<StorageMigrationState, 'state'>): boolean {
	return state.state === 'copying';
}

/**
 * Stable fingerprint of the addressing half of a config (never credentials),
 * so a stored test result can say which configuration it belongs to.
 */
export function providerFingerprint(config: StorageProviderConfig): string {
	return [
		config.driver,
		config.providerType ?? '-',
		config.endpoint ?? '-',
		config.region,
		config.bucket ?? '-',
		config.forcePathStyle ? 'path' : 'vhost',
		config.publicBaseUrl ?? '-'
	].join('|');
}

/** Human label for the driver (used by the page and the CLI). */
export function driverLabel(config: StorageProviderConfig): string {
	return config.driver === 'local' ? 'local' : (config.providerType ?? 's3');
}

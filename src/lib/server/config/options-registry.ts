import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { options } from '$lib/server/db/config';
import { AI_FUNCTIONS } from '$lib/utils/ai-meta';
import { isValidIanaTimeZone } from '$lib/utils/timezone';
import { isPgAcceptableTimeZone, type PgTimeZoneExecutor } from '$lib/server/pg-timezone';

/** Site languages (same set as the posts `lang` CHECK, ledger §9.16). */
export const OPTION_LANGS = ['en', 'zh-cn', 'ja'] as const;

interface RegistryEntry {
	schema: z.ZodType;
	default: unknown;
}

/** Accepts the db client or a transaction - registry writes join caller transactions. */
type AppDb = typeof import('$lib/server/db').db;
type RegistryExecutor = Pick<AppDb, 'select' | 'insert'>;

/**
 * Lazy default executor: keeps this module importable from plain tsx scripts
 * (the app `db` handle reads `$env/dynamic/private`, which exists only inside
 * the SvelteKit runtime). Callers can inject their own executor instead.
 */
async function defaultExecutor(): Promise<RegistryExecutor> {
	return (await import('$lib/server/db')).db;
}

/**
 * Options registry (AI-1.1, ai-line plan §5.1): the single source of truth
 * for behaviour settings stored in the `options` KV table. `getOption` /
 * `setOption` are the only entry points - writes validate, unknown keys are
 * rejected, and every key ships a schema plus its default value. Defaults
 * mirror the ai-line plan §3.3 ledger; the AI-2.1 review batch moved the
 * numeric bounds here so route handlers cannot drift from the contract.
 */
export const optionRegistry = {
	'site.languages': {
		schema: z.object({ enabled: z.array(z.enum(OPTION_LANGS)) }),
		default: { enabled: [...OPTION_LANGS] }
	},
	'site.default_lang': {
		schema: z.enum(OPTION_LANGS),
		default: 'en'
	},
	'site.timezone': {
		// Ledger §13.9 / notes plan v0.4: IANA zone name. Validated by
		// probing Intl (never supportedValuesOf - it omits 'UTC'). Notes
		// fall back to this zone for the belongs-to date when their own
		// `tz` is null; jobs reuse it as the `job_schedules.tz` default
		// (ledger §24).
		schema: z.string().refine(isValidIanaTimeZone, '无效的 IANA 时区名'),
		default: 'UTC'
	},
	'notes.gate': {
		// Notes plan v0.4 §2.5 / ledger §13.9: TTL of the per-row unlock
		// cookie (token crypto lives in services/note-gate.ts). Days only;
		// the write side is the editor batch, no runtime writer yet.
		schema: z.object({ ttlDays: z.number().int().min(1).max(365) }),
		default: { ttlDays: 30 }
	},
	'ai.assignments': {
		schema: z.partialRecord(
			z.enum(AI_FUNCTIONS),
			z.object({ provider: z.string().optional(), model: z.string().optional() })
		),
		default: {}
	},
	'ai.budget': {
		schema: z.object({
			monthly: z.number().nonnegative(),
			currency: z.string().min(1),
			alertRatios: z.array(z.number().positive()),
			pauseAutoOnExceed: z.boolean()
		}),
		// Per §3.3: no budget by default; 80/90/100% alerts once set; overrun
		// pauses automatic tasks only (manual stays available).
		default: { monthly: 0, currency: 'USD', alertRatios: [0.8, 0.9, 1], pauseAutoOnExceed: true }
	},
	'ai.styleGuide': {
		schema: z.object({ text: z.string().max(20000, '风格指南过长（≤20000 字）') }),
		default: { text: '' }
	},
	'comments.moderation': {
		schema: z.object({
			enabled: z.boolean(),
			shadowMode: z.boolean(),
			keywords: z.array(z.string()),
			regexes: z.array(z.string()),
			linkThreshold: z.number('必须为数字').int('必须为整数').nonnegative('不能小于 0'),
			firstCommentHold: z.boolean(),
			trustedUsers: z.array(z.string()),
			thresholds: z
				.object({
					allow: z.number('必须为数字').min(0, '必须在 0–1 之间').max(1, '必须在 0–1 之间'),
					block: z.number('必须为数字').min(0, '必须在 0–1 之间').max(1, '必须在 0–1 之间')
				})
				// AI-2.1: cross-field order - "allow first, block above it".
				.refine((t) => t.allow < t.block, '放行阈值需小于拦截阈值')
		}),
		// Per §3.3: rules first, AI off until enabled, shadow mode on, the
		// WordPress-style link threshold, first comments held for review.
		default: {
			enabled: false,
			shadowMode: true,
			keywords: [],
			regexes: [],
			linkThreshold: 2,
			firstCommentHold: true,
			trustedUsers: [],
			thresholds: { allow: 0.9, block: 0.95 }
		}
	},
	'media.purge': {
		schema: z.object({
			pendingDays: z.number('必须为数字').int('必须为整数').positive('必须大于 0'),
			detachedDays: z.number('必须为数字').int('必须为整数').positive('必须大于 0')
		}),
		// Storage line §4.6: never-referenced `pending` blobs purge a week
		// after their LAST event (dedupe hits refresh updated_at), `detached`
		// blobs a month after detaching. Photos-linked files are exempt from
		// auto-purge entirely (gallery files are never cleaned silently).
		// Floor is 1 day (round-3 ruling): a destructive knob must not reach
		// zero; an explicit instant-clean switch can be added if ever needed.
		default: { pendingDays: 7, detachedDays: 30 }
	}
} as const satisfies Record<string, RegistryEntry>;

export type OptionKey = keyof typeof optionRegistry;
export type OptionValue<K extends OptionKey> = z.infer<(typeof optionRegistry)[K]['schema']>;

export const optionKeys = Object.keys(optionRegistry) as OptionKey[];

function entryFor(key: string): RegistryEntry {
	const entry = (optionRegistry as Record<string, RegistryEntry>)[key];
	if (!entry) throw new Error(`Unknown option key: ${key}`);
	return entry;
}

/**
 * Read a validated value. A missing row yields the default; a corrupt row
 * logs and falls back to the default too - the site must not break on a bad
 * settings row (AI is an extension layer, §14.1).
 */
export async function getOption<K extends OptionKey>(
	key: K,
	executor?: RegistryExecutor
): Promise<OptionValue<K>> {
	const entry = entryFor(key);
	const database = executor ?? (await defaultExecutor());
	const rows = await database
		.select({ value: options.value })
		.from(options)
		.where(eq(options.name, key))
		.limit(1);
	if (rows.length === 0) return structuredClone(entry.default) as OptionValue<K>;
	const parsed = entry.schema.safeParse(rows[0].value);
	if (!parsed.success) {
		console.warn(`[options] "${key}" failed validation; using the default`, parsed.error.issues);
		return structuredClone(entry.default) as OptionValue<K>;
	}
	return parsed.data as OptionValue<K>;
}

/** Validate and upsert a value. Throws on invalid input or unknown keys. */
export async function setOption<K extends OptionKey>(
	key: K,
	value: OptionValue<K>,
	executor?: RegistryExecutor
): Promise<void> {
	const entry = entryFor(key);
	const parsed = entry.schema.parse(value); // ZodError on invalid input
	// Batch-5 tz closure (ledger §13.9): the Intl probe alone accepts names
	// PostgreSQL rejects ('Japan', 'US/Pacific'...) - stored, they 500 every
	// belongs-to query. Gate this write on pg_timezone_names too.
	if (key === 'site.timezone') {
		// The registry executor speaks select/insert; real db and tx handles
		// both expose execute, which the membership check rides on.
		const accepted = await isPgAcceptableTimeZone(
			parsed as string,
			executor as unknown as PgTimeZoneExecutor | undefined
		);
		if (!accepted) {
			throw new Error(
				`时区 "${String(parsed)}" 不被 PostgreSQL 接受（pg_timezone_names）；已拒绝写入`
			);
		}
	}
	const database = executor ?? (await defaultExecutor());
	await database
		.insert(options)
		.values({ name: key, value: parsed })
		.onConflictDoUpdate({ target: options.name, set: { value: parsed } });
}

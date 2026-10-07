import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { options } from '../db/config/index.ts';
import { AI_FUNCTIONS } from '../../utils/ai-meta.ts';
import { PROJECT_SYNC_PROVIDERS } from '../../utils/project-meta.ts';
import { isValidIanaTimeZone } from '../../utils/timezone.ts';
import { isPgAcceptableTimeZone, type PgTimeZoneExecutor } from '../pg-timezone.ts';

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
 *
 * All static imports use relative `.ts` specifiers (links line, 2026-10-06):
 * the same module must load under plain Node for the jobs side
 * (`jobs/builtin/links-check.ts`), which has no `$lib` alias resolution -
 * pass an executor there; the lazy `$lib/server/db` fallback stays
 * SvelteKit-only.
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
		// cookie (token crypto lives in services/note-gate.ts). Days only.
		// The editor never writes this yet - TTL currently changes only
		// through code or a deliberate `setOption` (no runtime writer).
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
	'ai.translation': {
		schema: z.object({
			minChars: z.number('必须为数字').int('必须为整数').min(1, '至少为 1'),
			notesAuto: z.boolean()
		}),
		// Micro-content line (ledger §17.5 / plan §1.6, C2): auto-enqueue
		// posts + notes - content below `minChars` produces no translation
		// candidate, manual translation is never gated. `notesAuto` opts
		// the notes surface into automatic enqueue (site default stays
		// review-first); per-note override lives in `notes.meta.translate`
		// mode. Cost guardrail = the existing ai.budget pause switch.
		default: { minChars: 300, notesAuto: true }
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
	},
	'friends.apply': {
		schema: z.object({
			enabled: z.boolean(),
			allowSubPath: z.boolean(),
			internalizeAvatars: z.boolean()
		}),
		// Links plan §2.6: applications open; home-page URLs only (no sub
		// paths); avatars stay hot-linked (localisation is a registered item).
		default: { enabled: true, allowSubPath: false, internalizeAvatars: false }
	},
	'friends.checks': {
		schema: z.object({
			enabled: z.boolean(),
			cadenceHours: z.number('必须为数字').int('必须为整数').min(1, '至少为 1 小时'),
			failStreak: z.number('必须为数字').int('必须为整数').min(1, '至少为 1'),
			backlinkStreak: z.number('必须为数字').int('必须为整数').min(1, '至少为 1'),
			graceDays: z.number('必须为数字').int('必须为整数').min(1, '至少为 1 天'),
			timeoutMs: z
				.number('必须为数字')
				.int('必须为整数')
				.min(1000, '至少 1000ms')
				.max(60000, '至多 60000ms'),
			concurrency: z.number('必须为数字').int('必须为整数').min(1, '至少为 1').max(16, '至多 16')
		}),
		// Plan §2.6 defaults: daily cadence, 3-strike outage / 2-strike
		// backlink loss before queueing, 30-day grace, 10s per fetch unit,
		// global concurrency 2 (politeness; per-host serialisation on top).
		default: {
			enabled: true,
			cadenceHours: 24,
			failStreak: 3,
			backlinkStreak: 2,
			graceDays: 30,
			timeoutMs: 10000,
			concurrency: 2
		}
	},
	'friends.policy': {
		schema: z.object({
			blockedHostSuffixes: z.array(z.string()),
			blockedTlds: z.array(z.string()),
			acceptedBacklinkHosts: z.array(z.string()),
			publicBannedList: z.boolean()
		}),
		// Plan §2.6: public-host / free-domain suffixes, free TLDs, extra
		// accepted backlink hosts (domain moves), public ban wall on.
		default: {
			blockedHostSuffixes: [
				'github.io',
				'vercel.app',
				'netlify.app',
				'pages.dev',
				'workers.dev',
				'gitlab.io',
				'eu.org',
				'js.cool',
				'blogspot.com',
				'wordpress.com',
				'neocities.org',
				'herokuapp.com',
				'onrender.com',
				'glitch.me',
				'deno.dev',
				'surge.sh',
				'notion.site',
				'web.app',
				'firebaseapp.com'
			],
			blockedTlds: ['.tk', '.ml', '.cf', '.ga', '.gq'],
			acceptedBacklinkHosts: [],
			publicBannedList: true
		}
	},
	'site.info': {
		schema: z.object({ name: z.string(), description: z.string(), avatar: z.string() }),
		// Public "our link info" block on /friends (plan §2.6).
		default: { name: 'Web Lair', description: '', avatar: '' }
	},
	'projects.sync_targets': {
		// Projects line §2.5: the accounts the sync job pulls public
		// repositories from; empty by default (the admin surface prompts for
		// configuration). `.trim()` normalizes entry whitespace and duplicate
		// (provider, account) pairs are rejected - a duplicate burns the same
		// anonymous quota twice for zero benefit (validation lives in the
		// registry per AI-1.1, not in route handlers).
		schema: z
			.array(
				z.object({
					provider: z.enum(PROJECT_SYNC_PROVIDERS),
					account: z.string().trim().min(1, '账号不能为空')
				})
			)
			.refine(
				(targets) =>
					new Set(targets.map(({ provider, account }) => JSON.stringify([provider, account])))
						.size === targets.length,
				'同一平台账号不能重复'
			),
		default: []
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

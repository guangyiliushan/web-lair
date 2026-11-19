import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { options } from '../db/config/index.ts';
import { AI_FUNCTIONS } from '../../utils/ai-meta.ts';
import { PROJECT_SYNC_PROVIDERS } from '../../utils/project-meta.ts';
import { isValidIanaTimeZone } from '../../utils/timezone.ts';
import { isValidCidr } from '../../utils/cidr.ts';
import { isPgAcceptableTimeZone, type PgTimeZoneExecutor } from '../pg-timezone.ts';
import { m } from '../../paraglide/messages.js';
import { OWNER_STATUS_DEFAULT, OWNER_STATUS_KINDS } from '../../config/owner-status.ts';
import {
	DEFAULT_NOTIFICATION_PREFERENCES,
	notificationPreferencesSchema
} from '../notifications/preferences.ts';
import {
	DEFAULT_PROVIDER_CONFIG,
	DEFAULT_STORAGE_ACTIVE,
	DEFAULT_STORAGE_MIGRATION,
	DEFAULT_STORAGE_STATUS,
	providerConfigSchema,
	storageActiveSchema,
	storageMigrationSchema,
	storageStatusSchema
} from '../storage/provider.ts';

/** Site languages (same set as the posts `lang` CHECK). */
export const OPTION_LANGS = ['en', 'zh-cn', 'ja'] as const;

/**
 * Public site asset URLs: empty means "unset".
 * `site.info.avatar` is https-only - the friend card renderer runs the same
 * URL through `safeHttpsUrl`, which drops everything else. The favicon may
 * additionally point at the same-origin `/i/` media proxy.
 */
function isHttpsUrl(value: string): boolean {
	if (!value) return false;
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

function isSiteIconUrl(value: string): boolean {
	if (value === '') return true;
	if (value.startsWith('/i/')) return true;
	return isHttpsUrl(value);
}

/** Descriptions are single-line: a stray newline breaks card/llms layout. */
function isSingleLine(value: string): boolean {
	return !/[\r\n]/.test(value);
}

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
 * Options registry: the single source of truth
 * for behaviour settings stored in the `options` KV table. `getOption` /
 * `setOption` are the only entry points - writes validate, unknown keys are
 * rejected, and every key ships a schema plus its default value. Defaults
 * mirror the product defaults; the numeric bounds live here so route handlers
 * cannot drift from the contract.
 *
 * All static imports use relative `.ts` specifiers: the same module must load
 * under plain Node for the jobs side
 * (`jobs/builtin/links-check.ts`), which has no `$lib` alias resolution -
 * pass an executor there; the lazy `$lib/server/db` fallback stays
 * SvelteKit-only.
 */
export const optionRegistry = {
	'site.languages': {
		// At least one language, no duplicates and
		// a canonical order. `default_lang ∈ enabled` is a cross-field
		// invariant the Site page's paired write enforces - a single-key
		// schema cannot see both options.
		schema: z.object({
			enabled: z
				.array(z.enum(OPTION_LANGS, { error: () => m.admin_option_err_languages_invalid() }))
				.min(1, { error: () => m.admin_option_err_languages_empty() })
				.refine((langs) => new Set(langs).size === langs.length, {
					error: () => m.admin_option_err_languages_duplicate()
				})
				.transform((langs) => OPTION_LANGS.filter((lang) => langs.includes(lang)))
		}),
		default: { enabled: [...OPTION_LANGS] }
	},
	'site.default_lang': {
		schema: z.enum(OPTION_LANGS),
		default: 'en'
	},
	'site.timezone': {
		// IANA zone name. Validated by
		// probing Intl (never supportedValuesOf - it omits 'UTC'). Notes
		// fall back to this zone for the belongs-to date when their own
		// `tz` is null; jobs reuse it as the `job_schedules.tz` default.
		schema: z
			.string()
			.refine(isValidIanaTimeZone, { error: () => m.admin_option_err_tz_invalid_iana() }),
		default: 'UTC'
	},
	'notes.gate': {
		// TTL of the per-row unlock
		// cookie (token crypto lives in services/note-gate.ts). Days only.
		// The editor never writes this yet - TTL currently changes only
		// through code or a deliberate `setOption` (no runtime writer).
		schema: z.object({
			ttlDays: z
				.number({ error: () => m.admin_settings_content_notes_ttl_hint() })
				.int({ error: () => m.admin_settings_content_notes_ttl_hint() })
				.min(1, { error: () => m.admin_settings_content_notes_ttl_hint() })
				.max(365, { error: () => m.admin_settings_content_notes_ttl_hint() })
		}),
		default: { ttlDays: 30 }
	},
	'ai.assignments': {
		schema: z.partialRecord(
			z.enum(AI_FUNCTIONS),
			z.object({
				provider: z.string().optional(),
				model: z.string().optional()
			})
		),
		// A missing key is a disabled slot; a present but empty object means
		// "follow the default pool", which has no provider or model of its own.
		default: {}
	},
	'ai.budget': {
		schema: z.object({
			monthly: z.number().nonnegative(),
			currency: z.string().min(1),
			alertRatios: z.array(z.number().positive()),
			pauseAutoOnExceed: z.boolean()
		}),
		// No budget by default; 80/90/100% alerts once set; overrun
		// pauses automatic tasks only (manual stays available).
		default: { monthly: 0, currency: 'USD', alertRatios: [0.8, 0.9, 1], pauseAutoOnExceed: true }
	},
	'ai.styleGuide': {
		schema: z.object({
			text: z.string().max(20000, { error: () => m.admin_option_err_style_too_long() })
		}),
		default: { text: '' }
	},
	'ai.translation': {
		schema: z.object({
			minChars: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1, { error: () => m.admin_option_err_min1() }),
			notesAuto: z.boolean(),
			// Site-wide default mode: auto = generate candidates on publish;
			// acceptance stays manual in the workbench, review = generate a
			// candidate only, manual = no automatic enqueue. A post/note can
			// override this in its `meta.translate.mode`.
			defaultMode: z.enum(['auto', 'review', 'manual'])
		}),
		// Auto-enqueue
		// posts + notes - content below `minChars` produces no translation
		// candidate, manual translation is never gated. `notesAuto` opts
		// the notes surface into automatic enqueue (site default stays
		// review-first); per-note override lives in `notes.meta.translate`
		// mode. Cost guardrail = the existing ai.budget pause switch.
		default: { minChars: 300, notesAuto: true, defaultMode: 'review' }
	},
	'ai.summary': {
		schema: z.object({
			auto: z.boolean(),
			minChars: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1, { error: () => m.admin_option_err_min1() })
		}),
		// Summaries are opt-in: a publish only enqueues the job when `auto` is
		// true and the post has no author summary. `minChars` is measured in
		// code points over the plain-text body (not raw markdown).
		default: { auto: false, minChars: 100 }
	},
	'translations.retention': {
		schema: z.object({
			discardDays: z.number().int().min(0).max(3650)
		}),
		// Discarded candidates are a paper trail, not content: long enough to
		// notice a bad batch, short enough that the table does not grow for
		// ever. 0 keeps them indefinitely (the workbench can still delete one
		// at a time).
		default: { discardDays: 180 }
	},
	'ai.chat': {
		schema: z.object({
			retentionDays: z.number().int().min(0).max(3650)
		}),
		// 0 = never auto-prune. The prune job only deletes archived
		// conversations older than this; active threads stay manual.
		default: { retentionDays: 90 }
	},
	'ai.pricing': {
		schema: z.record(
			z.string(),
			z.object({
				inputPer1M: z.number().nonnegative().optional(),
				outputPer1M: z.number().nonnegative().optional(),
				per1MChars: z.number().nonnegative().optional(),
				// Where the numbers came from: the models.dev sync or a human.
				// Display-only (the editor badges it), never used for billing.
				source: z.enum(['catalog', 'manual']).optional()
			})
		),
		// Operator-maintained price table: `<provider name>/<model>` -> USD
		// prices. Missing entries produce `ai_usage.cost_estimate = NULL`
		// rather than a guessed cost. The settings page can fill this from the
		// public models.dev catalog (pricing-catalog.ts), which only ever adds
		// entries or, on request, replaces the ones it resolved.
		default: {}
	},
	'ai.crawl': {
		schema: z.object({ answerEngine: z.boolean(), training: z.boolean() }),
		// Two policy groups for robots.txt. These are voluntary signals (RFC
		// 9309 §1), never access control.
		default: { answerEngine: true, training: true }
	},
	'comments.enabled': {
		// Site-wide switch for NEW comments. Set false and the form
		// disappears and every submit path rejects; existing approved rows stay
		// visible (hiding them would be a separate `comments.visible`). A post
		// / note `allow_comment` can only narrow this, never widen it.
		schema: z.boolean(),
		default: true
	},
	'payments.enabled': {
		// Contract-only flag, deliberately without a consumer. Paid/member
		// content is NOT implemented: no table, no route, no settings UI reads
		// or writes this key, and paid/member access modes do not exist. It is
		// registered so the default is explicit and testable; flipping it on
		// changes nothing until the rest of the paid surface exists (provider,
		// tax/terms/refunds, entitlement model, SEO/leak-surface tests) and a
		// real schema window opens.
		schema: z.boolean(),
		default: false
	},
	'comments.privacy': {
		// Request-time IP handling for comments. Off by
		// default; when off no GeoIP lookup, no CIDR match and no country storage
		// happen (the per-IP rate bucket still runs). When
		// on, the IP is matched against blockedCidrs and used for the per-IP
		// limit only - the `comments.ip` column stays null. Country/region are
		// stored only with collectCountry (edge header provider required) and
		// cleared by the retention job after retentionDays.
		schema: z.object({
			enabled: z.boolean(),
			collectCountry: z.boolean(),
			showCountry: z.boolean(),
			retentionDays: z.number().int().min(1).max(3650),
			blockedCidrs: z
				.array(z.string().refine(isValidCidr, { error: () => m.admin_option_err_cidr() }))
				.max(200)
		}),
		default: {
			enabled: false,
			collectCountry: false,
			showCountry: false,
			retentionDays: 90,
			blockedCidrs: []
		}
	},
	'comments.moderation': {
		schema: z.object({
			enabled: z.boolean(),
			shadowMode: z.boolean(),
			keywords: z.array(z.string()),
			regexes: z.array(z.string()),
			linkThreshold: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.nonnegative({ error: () => m.admin_option_err_nonnegative() }),
			firstCommentHold: z.boolean(),
			trustedUsers: z.array(z.string()),
			thresholds: z
				.object({
					allow: z
						.number({ error: () => m.admin_option_err_number() })
						.min(0, { error: () => m.admin_option_err_unit01() })
						.max(1, { error: () => m.admin_option_err_unit01() }),
					block: z
						.number({ error: () => m.admin_option_err_number() })
						.min(0, { error: () => m.admin_option_err_unit01() })
						.max(1, { error: () => m.admin_option_err_unit01() })
				})
				// Cross-field order: "allow first, block above it".
				.refine((t) => t.allow < t.block, { error: () => m.admin_option_err_threshold_order() })
		}),
		// Rules first, AI off until enabled, shadow mode on, the
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
	'storage.provider': {
		// The SAVED candidate. Saving never changes the live
		// target - activation runs through `storage:migrate --cutover`.
		schema: providerConfigSchema,
		default: DEFAULT_PROVIDER_CONFIG
	},
	'storage.active': {
		// The live target plus its rollback slot. Written only by an activation
		// path (empty-bucket activation or the cutover/rollback CLI).
		schema: storageActiveSchema,
		default: DEFAULT_STORAGE_ACTIVE
	},
	'storage.status': {
		// Last connection probe and the bucket capabilities the purge
		// guard needs. Sanitized: no URL, key or driver message.
		schema: storageStatusSchema,
		default: DEFAULT_STORAGE_STATUS
	},
	'storage.migration': {
		// CLI migration bookkeeping. `copying` freezes uploads and makes
		// purge refuse; a stuck state needs `storage:migrate --reset`.
		schema: storageMigrationSchema,
		default: DEFAULT_STORAGE_MIGRATION
	},
	'media.purge': {
		schema: z.object({
			pendingDays: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.positive({ error: () => m.admin_option_err_positive() }),
			detachedDays: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.positive({ error: () => m.admin_option_err_positive() })
		}),
		// Never-referenced `pending` blobs purge a week
		// after their LAST event (dedupe hits refresh updated_at), `detached`
		// blobs a month after detaching. Photos-linked files are exempt from
		// auto-purge entirely (gallery files are never cleaned silently).
		// Floor is 1 day: a destructive knob must not reach
		// zero; an explicit instant-clean switch can be added if ever needed.
		default: { pendingDays: 7, detachedDays: 30 }
	},
	'friends.apply': {
		// Applications open; home-page URLs only (no sub paths).
		schema: z.object({
			enabled: z.boolean(),
			allowSubPath: z.boolean()
		}),
		default: { enabled: true, allowSubPath: false }
	},
	'friends.checks': {
		schema: z.object({
			enabled: z.boolean(),
			cadenceHours: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1, { error: () => m.admin_option_err_min1_hour() }),
			failStreak: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1, { error: () => m.admin_option_err_min1() }),
			backlinkStreak: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1, { error: () => m.admin_option_err_min1() }),
			graceDays: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1, { error: () => m.admin_option_err_min1_day() }),
			timeoutMs: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1000, { error: () => m.admin_option_err_min1000ms() })
				.max(60000, { error: () => m.admin_option_err_max60000ms() }),
			concurrency: z
				.number({ error: () => m.admin_option_err_number() })
				.int({ error: () => m.admin_option_err_int() })
				.min(1, { error: () => m.admin_option_err_min1() })
				.max(16, { error: () => m.admin_option_err_max16() })
		}),
		// Defaults: daily cadence, 3-strike outage / 2-strike
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
		// Public-host / free-domain suffixes, free TLDs, extra
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
		// `name` feeds friend cards, llms.txt, the web manifest and
		// `og:site_name`; `description` is the friend-card
		// blurb; `avatar` is the optional card avatar. All three are
		// edited on Settings → Site.
		schema: z.object({
			name: z
				.string()
				.trim()
				.min(1, { error: () => m.admin_option_err_name_required() })
				.max(80, { error: () => m.admin_option_err_name_too_long() }),
			description: z
				.string()
				.trim()
				.max(300, { error: () => m.admin_option_err_description_too_long() })
				.refine(isSingleLine, { error: () => m.admin_option_err_description_multiline() }),
			avatar: z
				.string()
				.trim()
				.max(2048, { error: () => m.admin_option_err_url_too_long() })
				.refine((value) => value === '' || isHttpsUrl(value), {
					error: () => m.admin_option_err_avatar_url()
				})
		}),
		// Public "our link info" block on /friends.
		default: { name: 'Web Lair', description: '', avatar: '' }
	},
	'site.icon': {
		// Favicon: empty url = the bundled static asset; `version`
		// is bumped by the Site page on every save so the root layout's
		// `?v=` cache bust changes even when the URL does not.
		schema: z.object({
			url: z
				.string()
				.trim()
				.max(2048, { error: () => m.admin_option_err_url_too_long() })
				.refine(isSiteIconUrl, { error: () => m.admin_option_err_icon_url() }),
			version: z.number().int().nonnegative()
		}),
		default: { url: '', version: 0 }
	},
	// `site.owner` is retired: the header reads
	// site_identity -> user_profiles -> user. Do not reintroduce a projection.
	'site.ownerStatus': {
		// Owner activity ticket next to the badge (static stage): one datum —
		// the app/site name (capped at 10 chars in the UI) plus its icon.
		// `kind` only picks the indicator and the spoken verb; `enabled: false`
		// hides the ticket, not the badge.
		schema: z.object({
			enabled: z.boolean(),
			kind: z.enum(OWNER_STATUS_KINDS),
			detail: z.string(),
			iconUrl: z.string(),
			href: z.string()
		}),
		default: OWNER_STATUS_DEFAULT
	},
	'presence.enabled': {
		// Master switch for the presence feature
		// (heartbeats, the SSE stream, the reader badge, the dashboard cards).
		schema: z.boolean(),
		default: true
	},
	'presence.readerView': {
		// Reader-side "N reading now" badge plus the position density strip.
		schema: z.boolean(),
		default: true
	},
	'presence.readerDots': {
		// Individual position dots on the READER widget's dots layer; the
		// effective flag for a viewer is this option OR an admin session
		// (admins always see dots on content pages). The badge/histogram
		// layer is gated by presence.readerView instead — the two switches
		// are independent.
		schema: z.boolean(),
		default: false
	},
	'projects.sync_targets': {
		// The accounts the sync job pulls public
		// repositories from; empty by default (the admin surface prompts for
		// configuration). `.trim()` normalizes entry whitespace and duplicate
		// (provider, account) pairs are rejected - a duplicate burns the same
		// anonymous quota twice for zero benefit (validation lives in the
		// registry, not in route handlers).
		schema: z
			.array(
				z.object({
					provider: z.enum(PROJECT_SYNC_PROVIDERS),
					account: z
						.string()
						.trim()
						.min(1, { error: () => m.admin_option_err_account_required() })
				})
			)
			.refine(
				(targets) =>
					new Set(
						targets.map(({ provider, account }) =>
							JSON.stringify([provider, account.toLowerCase()])
						)
					).size === targets.length,
				{ error: () => m.admin_option_err_account_dup() }
			),
		default: []
	},
	'notifications.preferences': {
		// Per-group channel switches for the
		// notification outbox. The schema and the default object live in
		// `notifications/preferences.ts` so the drain (plain Node) parses the
		// SAME contract without importing this registry (which pulls paraglide
		// messages). Defaults: email on for comment/job/ops, Bark off.
		schema: notificationPreferencesSchema,
		default: DEFAULT_NOTIFICATION_PREFERENCES
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
 * settings row (AI is an extension layer).
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

/** Validate a value without writing it (used by agent proposals). */
export function validateOption<K extends OptionKey>(key: K, value: unknown): OptionValue<K> {
	const entry = entryFor(key);
	return entry.schema.parse(value) as OptionValue<K>;
}

/**
 * A registry write rejected by a database-backed check (the PostgreSQL
 * zoneinfo membership gate). Route actions map it to a 400 instead of a 500;
 * a `ZodError` covers the schema-level rejections.
 */
export class OptionWriteError extends Error {}

/** Validate and upsert a value. Throws on invalid input or unknown keys. */
export async function setOption<K extends OptionKey>(
	key: K,
	value: OptionValue<K>,
	executor?: RegistryExecutor
): Promise<void> {
	const entry = entryFor(key);
	const parsed = entry.schema.parse(value); // ZodError on invalid input
	// The Intl probe alone accepts names
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
			throw new OptionWriteError(m.admin_option_err_tz_pg_rejected({ tz: String(parsed) }));
		}
	}
	const database = executor ?? (await defaultExecutor());
	await database
		.insert(options)
		.values({ name: key, value: parsed })
		.onConflictDoUpdate({ target: options.name, set: { value: parsed } });
}

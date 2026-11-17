import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { links } from '../db/content/link.schema.ts';
import { getOption } from '../config/options-registry.ts';
import type { LinkStatus } from '../../utils/link-meta.ts';
import { executePrecheck, type PrecheckDeps } from './precheck.ts';
import { normalizeLinkUrl } from './normalize.ts';

/**
 * Public application flow: field validation, the
 * hard gates (non-HTTPS is rejected before any write because CHECK 3 keeps
 * every row https; free hosts/TLDs and banned domains are written as
 * `rejected` for audit), same-host de-duplication under an advisory lock,
 * and a bounded synchronous precheck that only ever produces evidence -
 * it never promotes a row.
 *
 * Deliberate deviations from the 2026-09-26 draft, both schema-driven:
 * - no RSS field (the table has no `rss` column; the plan's field list was
 *   written before the reshape);
 * - a non-HTTPS application cannot be stored as `rejected` (CHECK 3), so it
 *   is refused at the form instead of leaving an audit row.
 */

export type ApplyErrorCode =
	| 'disabled'
	| 'name-required'
	| 'name-too-long'
	| 'email-required'
	| 'email-invalid'
	| 'url-required'
	| 'url-invalid'
	| 'url-insecure'
	| 'url-subpath'
	| 'avatar-invalid'
	| 'description-too-long'
	| 'backlink-required'
	| 'backlink-invalid'
	| 'consent-required'
	| 'duplicate'
	| 'name-taken'
	| 'rate-limited';

export type ApplyRejectCode = 'blocked-host' | 'blocked-tld' | 'banned-domain';

export type ApplyOutcome =
	| { kind: 'pending'; id: string }
	| { kind: 'rejected'; id: string | null; code: ApplyRejectCode }
	| { kind: 'error'; code: ApplyErrorCode };

export interface ApplicationInput {
	name: string;
	url: string;
	avatar: string;
	description: string;
	email: string;
	backlinkUrl: string;
	consent: boolean;
}

export interface ApplyDeps extends PrecheckDeps {
	db?: ApplyDb;
	/** Client address for the per-IP daily cap (route supplies it). */
	address?: string;
	/** Injectable limiter; the default uses the shared cache store. */
	rateLimit?: (address: string) => Promise<{ allowed: boolean }>;
	/** Test seam: stub the precheck run persistence. */
	precheck?: typeof executePrecheck;
}

type AppDb = typeof db;
export type ApplyDb = Pick<AppDb, 'select' | 'insert' | 'update' | 'transaction'>;

export const APPLY_LIMITS = {
	name: 80,
	email: 254,
	description: 300,
	url: 500,
	avatar: 500
} as const;

/** One datum each for the route error mapping and the docs. */
export const APPLY_RATE_LIMIT = { limit: 5, windowSeconds: 24 * 60 * 60 } as const;

/** ?? requests, 5 s each, ~15 s total budget (shared with the admin). */
export { PRECHECK_BUDGET_MS, PRECHECK_TIMEOUT_MS } from './precheck.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ExistingLinkRow {
	id: string;
	status: LinkStatus;
	url: string;
}

export interface HardBlock {
	code: 'blocked-host' | 'blocked-tld';
	/** The matched suffix/TLD, stored in the audit reason. */
	detail: string;
}

export type ApplyPlan =
	| { kind: 'error'; code: 'duplicate' }
	| { kind: 'reject'; code: ApplyRejectCode; write: 'insert' | 'revive' | 'none' }
	| { kind: 'accept'; write: 'insert' | 'revive' };

/**
 * Pure decision table over the rows already registered on this host:
 *
 * | existing row(s)                    | outcome                          |
 * |------------------------------------|----------------------------------|
 * | any `banned`                       | reject (never overwrite the ban) |
 * | any pending/approved/outdated      | `duplicate` - nothing is written |
 * | a `rejected` row on the same URL   | revive that row                  |
 * | otherwise                          | insert                           |
 *
 * A banned row on the same URL is not touched: the ban is the audit record,
 * and the unique URL index would refuse a second row anyway.
 */
export function decideApplication(
	existing: readonly ExistingLinkRow[],
	facts: { url: string; hardBlock: HardBlock | null }
): ApplyPlan {
	const banned = existing.filter((row) => row.status === 'banned');
	if (banned.length > 0) {
		const sameUrl = banned.some((row) => row.url === facts.url);
		return { kind: 'reject', code: 'banned-domain', write: sameUrl ? 'none' : 'insert' };
	}
	if (
		existing.some(
			(row) => row.status === 'pending' || row.status === 'approved' || row.status === 'outdated'
		)
	) {
		return { kind: 'error', code: 'duplicate' };
	}
	const rejectedSameUrl = existing.some(
		(row) => row.status === 'rejected' && row.url === facts.url
	);
	const write = rejectedSameUrl ? 'revive' : 'insert';
	return facts.hardBlock
		? { kind: 'reject', code: facts.hardBlock.code, write }
		: { kind: 'accept', write };
}

/**
 * Free-host suffix match on the canonical host (`www.` already stripped):
 * `github.io` matches `foo.github.io`, not `notgithub.io`.
 */
export function matchBlockedHost(host: string, suffixes: readonly string[]): string | null {
	for (const raw of suffixes) {
		const suffix = raw.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
		if (!suffix) continue;
		if (host === suffix || host.endsWith(`.${suffix}`)) return suffix;
	}
	return null;
}

/** Free-TLD match (`'.tk'` matches `foo.tk`, never `foo.notk`). */
export function matchBlockedTld(host: string, tlds: readonly string[]): string | null {
	for (const raw of tlds) {
		const trimmed = raw.trim().toLowerCase().replace(/^\.+/, '');
		if (!trimmed) continue;
		const tld = `.${trimmed}`;
		if (host.endsWith(tld)) return tld;
	}
	return null;
}

function rejectReason(code: ApplyRejectCode, detail: string | null): string {
	return detail ? `auto: ${code} (${detail})` : `auto: ${code}`;
}

function tooLong(value: string, max: number): boolean {
	return value.length > max;
}

interface NormalizedFields {
	name: string;
	url: string;
	host: string;
	avatar: string | null;
	description: string | null;
	email: string;
	backlinkUrl: string;
}

type FieldResult = { ok: true; fields: NormalizedFields } | { ok: false; code: ApplyErrorCode };

function normalizeFields(input: ApplicationInput, options: { allowSubPath: boolean }): FieldResult {
	const name = input.name.trim();
	if (!name) return { ok: false, code: 'name-required' };
	if (tooLong(name, APPLY_LIMITS.name)) return { ok: false, code: 'name-too-long' };

	const email = input.email.trim();
	if (!email) return { ok: false, code: 'email-required' };
	if (tooLong(email, APPLY_LIMITS.email) || !EMAIL_RE.test(email)) {
		return { ok: false, code: 'email-invalid' };
	}

	const description = input.description.trim();
	if (tooLong(description, APPLY_LIMITS.description)) {
		return { ok: false, code: 'description-too-long' };
	}

	if (!input.consent) return { ok: false, code: 'consent-required' };

	const rawUrl = input.url.trim();
	if (!rawUrl) return { ok: false, code: 'url-required' };
	const site = normalizeLinkUrl(rawUrl, { allowSubPath: options.allowSubPath });
	if (!site.ok) {
		return {
			ok: false,
			code:
				site.reason === 'insecure'
					? 'url-insecure'
					: site.reason === 'subpath'
						? 'url-subpath'
						: 'url-invalid'
		};
	}

	const rawBacklink = input.backlinkUrl.trim();
	if (!rawBacklink) return { ok: false, code: 'backlink-required' };
	const backlink = normalizeLinkUrl(rawBacklink, { allowSubPath: true });
	if (!backlink.ok) return { ok: false, code: 'backlink-invalid' };

	const rawAvatar = input.avatar.trim();
	let avatar: string | null = null;
	if (rawAvatar) {
		if (tooLong(rawAvatar, APPLY_LIMITS.avatar)) return { ok: false, code: 'avatar-invalid' };
		try {
			if (new URL(rawAvatar).protocol !== 'https:') return { ok: false, code: 'avatar-invalid' };
		} catch {
			return { ok: false, code: 'avatar-invalid' };
		}
		avatar = rawAvatar;
	}

	return {
		ok: true,
		fields: {
			name,
			url: site.url,
			host: site.host,
			avatar,
			description: description || null,
			email,
			backlinkUrl: backlink.url
		}
	};
}

async function defaultRateLimit(address: string): Promise<{ allowed: boolean }> {
	const [{ getCache }, { rateLimit }] = await Promise.all([
		import('../cache/index.ts'),
		import('../cache/store.ts')
	]);
	return rateLimit(
		getCache(),
		`limits:friends:apply:${address}`,
		APPLY_RATE_LIMIT.limit,
		APPLY_RATE_LIMIT.windowSeconds
	);
}

function errorCodeFromDb(err: unknown): ApplyErrorCode | null {
	const code = (err as { code?: string }).code;
	const constraint = (err as { constraint?: string }).constraint ?? '';
	if (code !== '23505') return null;
	if (constraint === 'links_name_uniq') return 'name-taken';
	return 'duplicate';
}

/**
 * Apply for a friend link. Writes `pending` on a soft pass; writes (or
 * revives) `rejected` for the three auditable hard gates. Any error outcome
 * leaves the database untouched.
 */
export async function applyForLink(
	input: ApplicationInput,
	deps: ApplyDeps = {}
): Promise<ApplyOutcome> {
	const applyOption = await getOption('friends.apply');
	if (!applyOption.enabled) return { kind: 'error', code: 'disabled' };

	const parsed = normalizeFields(input, { allowSubPath: applyOption.allowSubPath });
	if (!parsed.ok) return { kind: 'error', code: parsed.code };

	const address = deps.address ?? 'unknown';
	const limiter = deps.rateLimit ?? defaultRateLimit;
	const rate = await limiter(address);
	if (!rate.allowed) return { kind: 'error', code: 'rate-limited' };

	const [checks, policy] = await Promise.all([
		getOption('friends.checks'),
		getOption('friends.policy')
	]);
	const blockedHost = matchBlockedHost(parsed.fields.host, policy.blockedHostSuffixes);
	const blockedTld = blockedHost ? null : matchBlockedTld(parsed.fields.host, policy.blockedTlds);
	const hardBlock: HardBlock | null = blockedHost
		? { code: 'blocked-host', detail: blockedHost }
		: blockedTld
			? { code: 'blocked-tld', detail: blockedTld }
			: null;

	const dbx: ApplyDb = deps.db ?? db;
	const now = deps.now ?? (() => new Date());
	const fields = parsed.fields;

	try {
		type Written =
			| { kind: 'error'; code: 'duplicate' }
			| { kind: 'reject'; code: ApplyRejectCode; id: string | null }
			| { kind: 'accept'; id: string };

		const written: Written = await dbx.transaction(async (tx): Promise<Written> => {
			// Serialise same-host applications: without a host-level unique
			// index two concurrent submissions could both pass dedupe.
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`web_lair.links.apply:${fields.host}`}))`
			);
			// Two targeted reads instead of one capped host scan: a long tail
			// of rejected rows must never hide a ban or an active row.
			const activeOrBanned = (await tx
				.select({ id: links.id, status: links.status, url: links.url })
				.from(links)
				.where(
					and(
						eq(links.host, fields.host),
						inArray(links.status, ['banned', 'pending', 'approved', 'outdated'])
					)
				)
				.limit(5)) as ExistingLinkRow[];
			const rejectedSameUrl = (await tx
				.select({ id: links.id, status: links.status, url: links.url })
				.from(links)
				.where(
					and(eq(links.host, fields.host), eq(links.status, 'rejected'), eq(links.url, fields.url))
				)
				.limit(1)) as ExistingLinkRow[];
			const existing = [...activeOrBanned, ...rejectedSameUrl];
			const plan = decideApplication(existing, { url: fields.url, hardBlock });
			if (plan.kind === 'error') return { kind: 'error', code: plan.code };

			const writeRow = async (
				status: LinkStatus,
				reason: string | null
			): Promise<string | null> => {
				if (plan.write === 'insert') {
					const [row] = await tx
						.insert(links)
						.values({
							...fields,
							status,
							reason,
							reviewedAt: status === 'rejected' ? now() : null,
							checkEnabled: status === 'pending'
						})
						.returning({ id: links.id });
					return row.id;
				}
				const revive = existing.find((row) => row.status === 'rejected' && row.url === fields.url);
				if (!revive) return null;
				const updated = await tx
					.update(links)
					.set({
						...fields,
						status,
						reason,
						reviewedAt: status === 'rejected' ? now() : null,
						reviewedBy: null,
						lostSince: null,
						recentChecks: null,
						checkEnabled: status === 'pending'
					})
					.where(and(eq(links.id, revive.id), eq(links.status, 'rejected')))
					.returning({ id: links.id });
				return updated[0]?.id ?? null;
			};

			if (plan.kind === 'accept') {
				const id = await writeRow('pending', null);
				return id ? { kind: 'accept', id } : { kind: 'error', code: 'duplicate' };
			}

			if (plan.write === 'none') return { kind: 'reject', code: plan.code, id: null };
			const id = await writeRow('rejected', rejectReason(plan.code, hardBlock?.detail ?? null));
			return id ? { kind: 'reject', code: plan.code, id } : { kind: 'error', code: 'duplicate' };
		});

		if (written.kind === 'error') return written;
		if (written.kind === 'reject') {
			// `write: none` means the URL is already a banned row: the ban is
			// the record, the visitor just gets the refusal.
			return { kind: 'rejected', id: written.id, code: written.code };
		}

		try {
			await (deps.precheck ?? executePrecheck)({
				db: dbx,
				link: { id: written.id, url: fields.url, backlinkUrl: fields.backlinkUrl },
				trigger: 'application',
				config: { checks, policy },
				deps
			});
		} catch (err) {
			// The application itself landed; a failed evidence write must not
			// turn the visitor's accepted submission into a 500.
			console.warn('[links] precheck run write failed', err);
		}
		return { kind: 'pending', id: written.id };
	} catch (err) {
		const code = errorCodeFromDb(err);
		if (code) return { kind: 'error', code };
		throw err;
	}
}

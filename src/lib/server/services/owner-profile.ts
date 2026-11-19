import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { userProfiles, type ProfileLink } from '$lib/server/db/account';
import { user } from '$lib/server/db/auth.schema';
import { homeHero, siteIdentity } from '$lib/server/db/settings';
import type { LocalizedCopy } from '$lib/server/db/settings';
import { recordActivity } from '$lib/server/audit';
import { OPTION_LANGS } from '$lib/server/config/options-registry';
import type { SiteOwner } from '$lib/config/owner-status';
import { SOCIAL_PRESETS, isSafeSocialHref, type SocialUserPlatform } from '$lib/config/social';

/**
 * Owner profile + home hero writes are owner-only: the `site_identity` pointer is re-checked
 * against the session actor inside the transaction.
 * No pointer, a mismatched actor or a non-owner pointer each fail 409; GET never self-heals.
 * Audit rows (`profile.update` / `home.update`) carry before/after values but no refs
 * (`activities.ref_id` is a uuid, auth ids are text) and set `deliver: false`.
 */
export interface OwnerProfile {
	userId: string;
	displayName: string;
	headerLabel: string | null;
	avatarUrl: string | null;
	links: ProfileLink[] | null;
}

export interface OwnerEditorView {
	profile: OwnerProfile | null;
	email: string | null;
	pointerUserId: string | null;
}

export type OwnerProfileReadExecutor = Pick<typeof db, 'select'>;
type AppDb = typeof db;
export type OwnerProfileWriteExecutor = Pick<AppDb, 'transaction'>;
type OwnerTx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

export interface OwnerProfileInput {
	displayName: string;
	headerLabel?: string | null;
	avatarUrl?: string | null;
	links?: ProfileLink[] | null;
}

export interface HomeHeroInput {
	title?: LocalizedCopy;
	subtitlePrefix?: LocalizedCopy;
	subtitleHighlight?: LocalizedCopy;
	description?: LocalizedCopy;
	welcome?: LocalizedCopy;
}

export type OwnerProfileErrorCode =
	| 'display_name_invalid'
	| 'header_label_invalid'
	| 'avatar_url_invalid'
	| 'links_invalid'
	| 'hero_invalid'
	| 'owner_pointer_missing'
	| 'owner_pointer_mismatch'
	| 'owner_profile_missing';

/** Typed failure: `status` is 400 for input, 409 for pointer/profile state. */
export class OwnerProfileError extends Error {
	constructor(
		readonly code: OwnerProfileErrorCode,
		message: string,
		readonly status: 400 | 409
	) {
		super(message);
		this.name = 'OwnerProfileError';
	}
}

/** Grapheme count (emoji ZWJ sequences and CJK count as one cell). */
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function countGraphemes(value: string): number {
	return [...GRAPHEME_SEGMENTER.segment(value)].length;
}

const DISPLAY_NAME_MAX = 80;
const HEADER_LABEL_MAX = 6;
const AVATAR_URL_MAX = 2048;
const LINK_LABEL_MAX = 40;
const LINKS_MAX = 8;
const HERO_TITLE_MAX = 120;
const HERO_DESCRIPTION_MAX = 300;

const SOCIAL_PRESET_PLATFORMS = Object.keys(SOCIAL_PRESETS) as SocialUserPlatform[];

function invalid(code: OwnerProfileErrorCode, message: string): never {
	throw new OwnerProfileError(code, message, 400);
}

function assertPlainText(value: string, code: OwnerProfileErrorCode): string {
	for (const char of value) {
		const point = char.codePointAt(0) ?? 0;
		if (point < 0x20 || point === 0x7f) {
			invalid(code, 'Control characters are not allowed.');
		}
	}
	return value;
}

export function normalizeDisplayName(value: unknown): string {
	if (typeof value !== 'string') invalid('display_name_invalid', 'Display name is required.');
	const name = assertPlainText(value.trim(), 'display_name_invalid');
	const length = countGraphemes(name);
	if (length < 1 || length > DISPLAY_NAME_MAX) {
		invalid('display_name_invalid', `Display name must be 1-${DISPLAY_NAME_MAX} characters.`);
	}
	return name;
}

/** Empty = full name; the DB stores NULL rather than an empty string. */
export function normalizeHeaderLabel(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') invalid('header_label_invalid', 'Header label must be text.');
	const label = assertPlainText(value.trim(), 'header_label_invalid');
	if (label === '') return null;
	if (/\s/.test(label)) invalid('header_label_invalid', 'Header label must be a single word.');
	const length = countGraphemes(label);
	if (length < 1 || length > HEADER_LABEL_MAX) {
		invalid('header_label_invalid', `Header label must be 1-${HEADER_LABEL_MAX} characters.`);
	}
	return label;
}

/** URL-only for now: external https or a site-internal /i/ locator. */
export function normalizeAvatarUrl(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'string') invalid('avatar_url_invalid', 'Avatar must be a URL.');
	const url = assertPlainText(value.trim(), 'avatar_url_invalid');
	if (url === '') return null;
	if (url.length > AVATAR_URL_MAX) invalid('avatar_url_invalid', 'Avatar URL is too long.');
	if (url.startsWith('/i/')) {
		if (url.includes('..') || url.includes('\\')) {
			invalid('avatar_url_invalid', 'Avatar path is not valid.');
		}
		return url;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		invalid('avatar_url_invalid', 'Avatar must be an https URL or /i/ path.');
	}
	if (parsed.protocol !== 'https:') {
		invalid('avatar_url_invalid', 'Avatar must use https.');
	}
	return parsed.toString();
}

export function normalizeLinks(value: unknown): ProfileLink[] | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) invalid('links_invalid', 'Social links must be a list.');
	if (value.length > LINKS_MAX) {
		invalid('links_invalid', `At most ${LINKS_MAX} social links are allowed.`);
	}
	const seen = new Set<string>();
	const links: ProfileLink[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') invalid('links_invalid', 'A social link is malformed.');
		const platform = (raw as ProfileLink).platform;
		const hrefRaw = (raw as ProfileLink).href;
		const labelRaw = (raw as ProfileLink).label;
		if (
			typeof platform !== 'string' ||
			!SOCIAL_PRESET_PLATFORMS.includes(platform as SocialUserPlatform)
		) {
			invalid('links_invalid', 'Unknown social platform.');
		}
		if (typeof hrefRaw !== 'string') invalid('links_invalid', 'A social link needs a URL.');
		const href = assertPlainText(hrefRaw.trim(), 'links_invalid');
		const typedPlatform = platform as SocialUserPlatform;
		if (!isSafeSocialHref(typedPlatform, href)) {
			if (typedPlatform === 'email') {
				invalid('links_invalid', 'Email links must be a mailto: address.');
			}
			let parsed: URL;
			try {
				parsed = new URL(href);
			} catch {
				invalid('links_invalid', 'Social links must be absolute https URLs.');
			}
			if (parsed.protocol !== 'https:') {
				invalid('links_invalid', 'Social links must use https.');
			}
			invalid('links_invalid', `Link host does not match the ${typedPlatform} preset.`);
		}
		let label: string | undefined;
		if (labelRaw !== undefined && labelRaw !== null) {
			if (typeof labelRaw !== 'string') invalid('links_invalid', 'Link label must be text.');
			const trimmed = assertPlainText(labelRaw.trim(), 'links_invalid');
			if (trimmed !== '') {
				if (countGraphemes(trimmed) > LINK_LABEL_MAX) {
					invalid('links_invalid', 'Link label is too long.');
				}
				label = trimmed;
			}
		}
		const key = `${platform}|${href}`;
		if (seen.has(key)) invalid('links_invalid', 'Duplicate social link.');
		seen.add(key);
		links.push(label ? { platform, href, label } : { platform, href });
	}
	return links.length > 0 ? links : null;
}

export function normalizeOwnerProfileInput(input: OwnerProfileInput): {
	displayName: string;
	headerLabel: string | null;
	avatarUrl: string | null;
	links: ProfileLink[] | null;
} {
	return {
		displayName: normalizeDisplayName(input.displayName),
		headerLabel: normalizeHeaderLabel(input.headerLabel),
		avatarUrl: normalizeAvatarUrl(input.avatarUrl),
		links: normalizeLinks(input.links)
	};
}

function normalizeLocalizedCopy(
	value: unknown,
	field: string,
	maxGraphemes: number
): LocalizedCopy {
	if (value === undefined || value === null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) {
		invalid('hero_invalid', `${field} must be a locale map.`);
	}
	const out: LocalizedCopy = {};
	for (const [locale, raw] of Object.entries(value as Record<string, unknown>)) {
		if (!(OPTION_LANGS as readonly string[]).includes(locale)) {
			invalid('hero_invalid', `Unsupported locale: ${locale}.`);
		}
		if (typeof raw !== 'string') invalid('hero_invalid', `${field}.${locale} must be text.`);
		const text = assertPlainText(raw.trim(), 'hero_invalid');
		if (text === '') continue; // empty string = remove the override
		if (countGraphemes(text) > maxGraphemes) {
			invalid('hero_invalid', `${field}.${locale} is too long.`);
		}
		out[locale] = text;
	}
	return out;
}

export function normalizeHomeHeroInput(input: HomeHeroInput): {
	title: LocalizedCopy;
	subtitlePrefix: LocalizedCopy;
	subtitleHighlight: LocalizedCopy;
	description: LocalizedCopy;
	welcome: LocalizedCopy;
} {
	return {
		title: normalizeLocalizedCopy(input.title, 'title', HERO_TITLE_MAX),
		subtitlePrefix: normalizeLocalizedCopy(input.subtitlePrefix, 'subtitlePrefix', HERO_TITLE_MAX),
		subtitleHighlight: normalizeLocalizedCopy(
			input.subtitleHighlight,
			'subtitleHighlight',
			HERO_TITLE_MAX
		),
		description: normalizeLocalizedCopy(input.description, 'description', HERO_DESCRIPTION_MAX),
		welcome: normalizeLocalizedCopy(input.welcome, 'welcome', HERO_TITLE_MAX)
	};
}

type OwnerRow = {
	userId: string;
	email: string;
	userName: string;
	userImage: string | null;
	displayName: string | null;
	headerLabel: string | null;
	avatarUrl: string | null;
	links: ProfileLink[] | null;
};

async function selectOwnerRow(executor: OwnerProfileReadExecutor): Promise<OwnerRow | null> {
	const rows = await executor
		.select({
			userId: user.id,
			email: user.email,
			userName: user.name,
			userImage: user.image,
			displayName: userProfiles.displayName,
			headerLabel: userProfiles.headerLabel,
			avatarUrl: userProfiles.avatarUrl,
			links: userProfiles.links
		})
		.from(siteIdentity)
		.innerJoin(user, eq(user.id, siteIdentity.ownerUserId))
		.leftJoin(
			userProfiles,
			and(eq(userProfiles.userId, user.id), eq(userProfiles.status, 'active'))
		)
		.where(and(eq(siteIdentity.id, 1), eq(user.role, 'owner')))
		.limit(1);
	return rows[0] ?? null;
}

function rowToProfile(row: OwnerRow): OwnerProfile {
	return {
		userId: row.userId,
		displayName: row.displayName ?? row.userName,
		headerLabel: row.headerLabel ?? null,
		avatarUrl: row.avatarUrl ?? row.userImage ?? null,
		links: row.links ?? null
	};
}

export async function loadOwnerProfile(
	executor: OwnerProfileReadExecutor = db
): Promise<OwnerProfile | null> {
	const row = await selectOwnerRow(executor);
	return row ? rowToProfile(row) : null;
}

/** Admin-side view: adds the owner email and the pointer id for the guard UI. */
export async function loadOwnerEditorView(
	executor: OwnerProfileReadExecutor = db
): Promise<OwnerEditorView> {
	const row = await selectOwnerRow(executor);
	if (!row) return { profile: null, email: null, pointerUserId: null };
	return { profile: rowToProfile(row), email: row.email, pointerUserId: row.userId };
}

export interface HomeHeroRecord {
	title: LocalizedCopy;
	subtitlePrefix: LocalizedCopy;
	subtitleHighlight: LocalizedCopy;
	description: LocalizedCopy;
	welcome: LocalizedCopy;
	updatedAt: Date | null;
	updatedBy: string | null;
}

/** Admin view needs the raw overrides; the homepage resolves them per request. */
export async function loadHomeHero(
	executor: OwnerProfileReadExecutor = db
): Promise<HomeHeroRecord> {
	const rows = await executor
		.select({
			title: homeHero.title,
			subtitlePrefix: homeHero.subtitlePrefix,
			subtitleHighlight: homeHero.subtitleHighlight,
			description: homeHero.description,
			welcome: homeHero.welcome,
			updatedAt: homeHero.updatedAt,
			updatedBy: homeHero.updatedBy
		})
		.from(homeHero)
		.where(eq(homeHero.id, 1))
		.limit(1);
	return (
		rows[0] ?? {
			title: {},
			subtitlePrefix: {},
			subtitleHighlight: {},
			description: {},
			welcome: {},
			updatedAt: null,
			updatedBy: null
		}
	);
}

/** Header badge projection: full name stays the identity; label is layout-only. */
export function ownerProfileToSiteOwner(profile: OwnerProfile): SiteOwner {
	return {
		name: profile.displayName,
		avatar: profile.avatarUrl ?? '',
		headerLabel: profile.headerLabel
	};
}

async function assertOwnerPointer(tx: OwnerTx, actorId: string): Promise<string> {
	const pointerRows = await tx
		.select({ ownerUserId: siteIdentity.ownerUserId })
		.from(siteIdentity)
		.where(eq(siteIdentity.id, 1))
		.limit(1);
	const pointerId = pointerRows[0]?.ownerUserId ?? null;
	if (!pointerId) {
		throw new OwnerProfileError(
			'owner_pointer_missing',
			'The site owner pointer is not set. Run `pnpm ops site rebuild-owner`.',
			409
		);
	}
	const actorRows = await tx
		.select({ id: user.id, role: user.role })
		.from(user)
		.where(eq(user.id, actorId))
		.limit(1);
	const actor = actorRows[0];
	if (!actor || actor.id !== pointerId || actor.role !== 'owner') {
		console.warn('[owner] pointer mismatch', { actorId, pointerId });
		throw new OwnerProfileError(
			'owner_pointer_mismatch',
			'This profile belongs to a different owner. Run `pnpm ops site rebuild-owner`.',
			409
		);
	}
	return pointerId;
}

function profileSnapshot(input: {
	displayName: string;
	headerLabel: string | null;
	avatarUrl: string | null;
	links: ProfileLink[] | null;
}): Record<string, unknown> {
	return {
		display_name: input.displayName,
		header_label: input.headerLabel,
		avatar_url: input.avatarUrl,
		links: input.links
	};
}

export async function saveOwnerProfile(
	input: OwnerProfileInput,
	options: { actorId: string; executor?: OwnerProfileWriteExecutor }
): Promise<OwnerProfile> {
	const normalized = normalizeOwnerProfileInput(input);
	const executor = options.executor ?? db;
	return executor.transaction(async (tx) => {
		const ownerId = await assertOwnerPointer(tx, options.actorId);
		const beforeRows = await tx
			.select({
				displayName: userProfiles.displayName,
				headerLabel: userProfiles.headerLabel,
				avatarUrl: userProfiles.avatarUrl,
				links: userProfiles.links
			})
			.from(userProfiles)
			.where(and(eq(userProfiles.userId, ownerId), eq(userProfiles.status, 'active')))
			.limit(1);
		const before = beforeRows[0];
		if (!before) {
			throw new OwnerProfileError(
				'owner_profile_missing',
				'The owner has no user_profiles row. Run `pnpm ops site seed-owner`.',
				409
			);
		}
		const updatedRows = await tx
			.update(userProfiles)
			.set(normalized)
			.where(eq(userProfiles.userId, ownerId))
			.returning({
				displayName: userProfiles.displayName,
				headerLabel: userProfiles.headerLabel,
				avatarUrl: userProfiles.avatarUrl,
				links: userProfiles.links
			});
		const updated = updatedRows[0];
		if (!updated) {
			throw new OwnerProfileError(
				'owner_profile_missing',
				'The owner profile row disappeared during the save.',
				409
			);
		}
		await recordActivity(tx, {
			event: 'profile.update',
			actorId: options.actorId,
			payload: {
				fields: ['display_name', 'header_label', 'avatar_url', 'links'],
				before: profileSnapshot(before),
				after: profileSnapshot(updated)
			},
			deliver: false
		});
		return {
			userId: ownerId,
			displayName: updated.displayName,
			headerLabel: updated.headerLabel ?? null,
			avatarUrl: updated.avatarUrl ?? null,
			links: updated.links ?? null
		};
	});
}

export async function saveHomeHero(
	input: HomeHeroInput,
	options: { actorId: string; executor?: OwnerProfileWriteExecutor }
): Promise<ReturnType<typeof normalizeHomeHeroInput>> {
	const normalized = normalizeHomeHeroInput(input);
	const executor = options.executor ?? db;
	return executor.transaction(async (tx) => {
		await assertOwnerPointer(tx, options.actorId);
		const beforeRows = await tx
			.select({
				title: homeHero.title,
				subtitlePrefix: homeHero.subtitlePrefix,
				subtitleHighlight: homeHero.subtitleHighlight,
				description: homeHero.description,
				welcome: homeHero.welcome
			})
			.from(homeHero)
			.where(eq(homeHero.id, 1))
			.limit(1);
		const before = beforeRows[0] ?? null;
		await tx
			.insert(homeHero)
			.values({ id: 1, ...normalized, updatedBy: options.actorId })
			.onConflictDoUpdate({
				target: homeHero.id,
				set: { ...normalized, updatedBy: options.actorId, updatedAt: new Date() }
			});
		await recordActivity(tx, {
			event: 'home.update',
			actorId: options.actorId,
			payload: {
				fields: ['title', 'subtitle_prefix', 'subtitle_highlight', 'description', 'welcome'],
				before,
				after: normalized
			},
			deliver: false
		});
		return normalized;
	});
}

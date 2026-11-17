import { asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { links } from '$lib/server/db/content';

/**
 * Public read face of the links registry. Deliberately
 * separate from `links/admin.ts`: the admin selection carries `email`,
 * `recent_checks` and reviewer fields, none of which may ever reach an
 * anonymous page payload. Every list is capped (same 200-row public ceiling
 * the projects grid uses) and URLs are re-filtered on the render side.
 */
export const PUBLIC_LINK_LIMIT = 200;

export interface PublicFriendCard {
	id: string;
	name: string;
	url: string;
	host: string;
	avatar: string | null;
	description: string | null;
}

export interface PublicBannedCard {
	id: string;
	name: string;
	url: string;
	host: string;
	reason: string;
}

export interface PublicFriends {
	approved: PublicFriendCard[];
	outdated: PublicFriendCard[];
	banned: PublicBannedCard[];
}

const cardSelection = {
	id: links.id,
	name: links.name,
	url: links.url,
	host: links.host,
	avatar: links.avatar,
	description: links.description
} as const;

/** `img src` may only carry https (an http avatar is mixed content). */
export function safeHttpsUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		return new URL(value).protocol === 'https:' ? value : null;
	} catch {
		return null;
	}
}

/**
 * Three bounded reads in parallel. The approved order matches the admin tab
 * (`sort_order, name, id`); the outdated zone keeps the oldest loss first so
 * the site nearest its prune deadline is the first thing a visitor sees;
 * banned rows are ordered by review time (DESC needs `nulls last` in PG).
 */
export async function listPublicFriends(options: {
	publicBannedList: boolean;
}): Promise<PublicFriends> {
	const approved = db
		.select(cardSelection)
		.from(links)
		.where(eq(links.status, 'approved'))
		.orderBy(asc(links.sortOrder), asc(links.name), asc(links.id))
		.limit(PUBLIC_LINK_LIMIT)
		.then((rows) => rows.map((row) => ({ ...row, avatar: safeHttpsUrl(row.avatar) })));

	const outdated = db
		.select(cardSelection)
		.from(links)
		.where(eq(links.status, 'outdated'))
		.orderBy(asc(links.lostSince), asc(links.id))
		.limit(PUBLIC_LINK_LIMIT)
		.then((rows) => rows.map((row) => ({ ...row, avatar: safeHttpsUrl(row.avatar) })));

	const banned = options.publicBannedList
		? db
				.select({
					id: links.id,
					name: links.name,
					url: links.url,
					host: links.host,
					reason: sql<string>`coalesce(${links.reason}, '')`
				})
				.from(links)
				.where(eq(links.status, 'banned'))
				.orderBy(sql`${links.reviewedAt} desc nulls last`, desc(links.createdAt), asc(links.id))
				.limit(PUBLIC_LINK_LIMIT)
		: Promise.resolve([] as PublicBannedCard[]);

	const [approvedRows, outdatedRows, bannedRows] = await Promise.all([approved, outdated, banned]);
	return { approved: approvedRows, outdated: outdatedRows, banned: bannedRows };
}

import { desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { notes, posts } from '$lib/server/db/content';
import { session as authSession } from '$lib/server/db/auth.schema';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { readSitePresence } from '$lib/server/services/presence';
import { readTrafficSnapshot, summarizePageTraffic } from '$lib/server/analytics/sentinel';
import { visiblePostCondition } from '$lib/server/services/post-visibility';
import { visibleNoteCondition } from '$lib/server/services/note-visibility';
import { m } from '$lib/paraglide/messages';
import type { PageServerLoad } from './$types';

/** One point of the monthly publish series (`YYYY-MM` buckets). */
export interface PublishPoint {
	bucket: string;
	posts: number;
	notes: number;
}

/** One slice of the category ranking (`count` desc, at most 5 rows). */
export interface CategoryPoint {
	name: string;
	count: number;
}

/** One point of the daily comment series (`YYYY-MM-DD` buckets). */
export interface CommentPoint {
	bucket: string;
	total: number;
	approved: number;
}

/**
 * Admin dashboard (C3): the load is admin-guarded. The quick-action counters
 * and the data-statistics block read real rows; the realtime cards carry SSR
 * initial values from the presence service (site window / today's unique tabs
 * / daily peak sentinel) and the page upgrades them over the admin SSE
 * stream. When presence is disabled or the cache is unavailable the values
 * stay null and the cards render "—" (register E1/F3).
 *
 * Data-statistics scope (2026-10-21):
 *   - characters: every publicly visible body — posts + notes (visible),
 *     pages (visible, every locale), quotes, thoughts and moments; drafts,
 *     trash, private and future-scheduled rows are excluded;
 *   - reads / likes: posts + notes only — those are the only content tables
 *     with read_count / like_count. Quotes, thoughts, pages and moments have
 *     no equivalent counters (moments has up/down votes, not likes). Note:
 *     no write path currently increments these columns, so both cards read 0
 *     until read/like instrumentation lands;
 *   - friends: approved links; friend requests: pending links;
 *   - API calls, IP visits and site likes have no source in this app and were
 *     removed from the dashboard rather than rendered as fabricated values.
 */
export const load: PageServerLoad = async ({ locals }) => {
	await requireAdminRole();

	const now = new Date();
	const postVisibility = visiblePostCondition(now);
	const noteVisibility = visibleNoteCondition(now);
	const userId = locals.user?.id ?? '';
	const currentSessionId = locals.session?.id ?? '';

	const [
		globalRows,
		[postRow],
		[noteRow],
		recentSessions,
		siteTimezone,
		presenceEnabled,
		trafficSnapshot
	] = await Promise.all([
		// One round trip for the count-only metrics and the micro-content
		// character totals. Pages keep localized markdown in JSONB, so every
		// locale value counts toward the site's written output.
		db.execute(sql`
				select
					(select count(*)::int from pages) as pages,
					(select count(*)::int from categories) as categories,
					(select count(*)::int from comments where is_deleted = false) as comments_total,
					(select count(*)::int from comments where is_deleted = false and state = 'pending') as comments_unread,
					(select count(*)::int from links where status = 'approved') as friends,
					(select count(*)::int from links where status = 'pending') as friend_requests,
					(select count(*)::int from quotes) as quotes_total,
					(select coalesce(sum(char_length(content)), 0)::int from quotes) as quotes_chars,
					(select count(*)::int from thoughts) as thoughts_total,
					(select coalesce(sum(char_length(content)), 0)::int from thoughts) as thoughts_chars,
					(select count(*)::int from moments) as moments_total,
					(select coalesce(sum(char_length(content)), 0)::int from moments) as moments_chars,
					(select coalesce(sum(char_length(value)), 0)::int
					   from pages, jsonb_each_text(pages.content)
					  where pages.status = 'visible' and pages.content is not null) as pages_chars,

					/* Chart series (2026-10-21): three aggregates ride the same round
					   trip as the counters. Each is a JSON array so a sparse window is a
					   short list rather than a hole the client has to fill. Publish
					   visibility reuses the shared predicates, so the charts cannot drift
					   from the statistics block above. */
					(select coalesce(json_agg(json_build_object(
					           'bucket', s.bucket, 'posts', s.posts, 'notes', s.notes
					         ) order by s.bucket), '[]'::json)
					   from (
					     select to_char(date_trunc('month', u.ts), 'YYYY-MM') as bucket,
					            count(*) filter (where u.kind = 'post')::int as posts,
					            count(*) filter (where u.kind = 'note')::int as notes
					       from (
					         select posts.published_at as ts, 'post'::text as kind
					           from posts
					          where posts.published_at is not null and ${postVisibility}
					         union all
					         select notes.published_at as ts, 'note'::text as kind
					           from notes
					          where notes.published_at is not null and ${noteVisibility}
					       ) u
					      where u.ts >= date_trunc('month', now()) - interval '11 months'
					      group by 1
					   ) s) as publish_series,

					(select coalesce(json_agg(json_build_object('name', s.name, 'count', s.cnt)
					           order by s.cnt desc, s.name), '[]'::json)
					   from (
					     select c.name as name, count(*)::int as cnt
					       from posts p
					       join categories c on c.id = p.category_id
					      where p.status <> 'trash'
					      group by c.id, c.name
					      order by 2 desc, 1 asc
					      limit 5
					   ) s) as category_series,

					(select coalesce(json_agg(json_build_object(
					           'bucket', s.bucket, 'total', s.total, 'approved', s.approved
					         ) order by s.bucket), '[]'::json)
					   from (
					     select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as bucket,
					            count(*)::int as total,
					            count(*) filter (where state = 'approved')::int as approved
					       from comments
					      where is_deleted = false
					        and created_at >= date_trunc('day', now()) - interval '29 days'
					      group by 1
					   ) s) as comment_series
			`),
		db
			.select({
				total: sql<number>`(count(*) filter (where ${posts.status} <> 'trash'))::int`,
				chars: sql<number>`coalesce(sum(char_length(coalesce(${posts.content}, ''))) filter (where ${postVisibility}), 0)::int`,
				reads: sql<number>`coalesce(sum(${posts.readCount}) filter (where ${postVisibility}), 0)::int`,
				likes: sql<number>`coalesce(sum(${posts.likeCount}) filter (where ${postVisibility}), 0)::int`
			})
			.from(posts),
		db
			.select({
				total: sql<number>`count(*)::int`,
				chars: sql<number>`coalesce(sum(char_length(coalesce(${notes.content}, ''))) filter (where ${noteVisibility}), 0)::int`,
				reads: sql<number>`coalesce(sum(${notes.readCount}) filter (where ${noteVisibility}), 0)::int`,
				likes: sql<number>`coalesce(sum(${notes.likeCount}) filter (where ${noteVisibility}), 0)::int`
			})
			.from(notes),
		userId
			? db
					.select({
						id: authSession.id,
						createdAt: authSession.createdAt,
						ipAddress: authSession.ipAddress
					})
					.from(authSession)
					.where(eq(authSession.userId, userId))
					.orderBy(desc(authSession.createdAt))
					.limit(2)
			: Promise.resolve([] as Array<{ id: string; createdAt: Date; ipAddress: string | null }>),
		readSiteTimezone(),
		readPresenceEnabled(),
		// Fail-open traffic card (P6): the same 60 s cache the analytics
		// page uses; null means Sentinel is down or unconfigured.
		readTrafficSnapshot({ range: '24h' })
	]);

	const global = (
		globalRows as unknown as Array<{
			pages: number;
			categories: number;
			comments_total: number;
			comments_unread: number;
			friends: number;
			friend_requests: number;
			quotes_total: number;
			quotes_chars: number;
			thoughts_total: number;
			thoughts_chars: number;
			moments_total: number;
			moments_chars: number;
			pages_chars: number;
			publish_series: PublishPoint[];
			category_series: CategoryPoint[];
			comment_series: CommentPoint[];
		}>
	)[0] ?? {
		pages: 0,
		categories: 0,
		comments_total: 0,
		comments_unread: 0,
		friends: 0,
		friend_requests: 0,
		quotes_total: 0,
		quotes_chars: 0,
		thoughts_total: 0,
		thoughts_chars: 0,
		moments_total: 0,
		moments_chars: 0,
		pages_chars: 0,
		publish_series: [],
		category_series: [],
		comment_series: []
	};

	// "Last admin login" = the signed-in admin's previous session; on the
	// first login there is no previous row, so the current session is shown
	// and the component labels it as the first login. Excluding the current
	// session keeps this a login trace rather than a live session counter.
	const previousSession = recentSessions.find((row) => row.id !== currentSessionId) ?? null;
	const shownSession = previousSession ?? recentSessions[0] ?? null;

	const realtime = presenceEnabled ? await readSitePresence() : null;
	const trafficSummary = trafficSnapshot ? summarizePageTraffic(trafficSnapshot) : null;

	return {
		headerTitle: m.admin_nav_dashboard(),
		counts: {
			posts: postRow?.total ?? 0,
			notes: noteRow?.total ?? 0,
			quotes: global.quotes_total,
			thoughts: global.thoughts_total,
			moments: global.moments_total
		},
		stats: {
			pages: global.pages,
			categories: global.categories,
			comments: global.comments_total,
			commentsUnread: global.comments_unread,
			friends: global.friends,
			friendRequests: global.friend_requests,
			characters:
				(postRow?.chars ?? 0) +
				(noteRow?.chars ?? 0) +
				global.pages_chars +
				global.quotes_chars +
				global.thoughts_chars +
				global.moments_chars,
			reads: (postRow?.reads ?? 0) + (noteRow?.reads ?? 0),
			likes: (postRow?.likes ?? 0) + (noteRow?.likes ?? 0)
		},
		charts: {
			publish: fillMonths(normalizeSeries<PublishPoint>(global.publish_series), now, 12),
			categories: normalizeSeries<CategoryPoint>(global.category_series),
			comments: fillDays(normalizeSeries<CommentPoint>(global.comment_series), now, 30)
		},
		lastAdminLogin: shownSession
			? {
					at: shownSession.createdAt.toISOString(),
					ip: shownSession.ipAddress,
					first: previousSession === null
				}
			: null,
		siteTimezone,
		traffic: {
			available: trafficSnapshot !== null,
			pageRequests: trafficSummary?.pageRequests ?? null,
			pageRequestsLowerBound: trafficSummary?.pathsTruncated ?? false,
			visitors: trafficSnapshot?.overview.unique_visitors ?? null,
			notFound: trafficSummary?.notFoundRequests ?? null
		},
		presence: {
			enabled: presenceEnabled,
			site: realtime?.site ?? null,
			day: realtime?.day ?? null,
			peak: realtime?.peak ?? null
		}
	};
};

/**
 * `json_agg` answers a JSON value; depending on the driver that arrives as a
 * parsed array or as its string form. Normalise once here so the page can
 * treat every series as `T[]` and never branch on the transport.
 */
function normalizeSeries<T>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			return Array.isArray(parsed) ? (parsed as T[]) : [];
		} catch {
			return [];
		}
	}
	return [];
}

/**
 * Sparse buckets would make a line chart slope across the gap and invent
 * activity that never happened, so the monthly window is emitted whole: every
 * month in `months` appears, empty ones as zeroes. The SQL only returns months
 * that had a publish.
 */
function fillMonths(
	rows: PublishPoint[],
	now: Date,
	months: number
): Array<PublishPoint & { date: Date }> {
	const found = new Map(rows.map((row) => [row.bucket, row]));
	const out: Array<PublishPoint & { date: Date }> = [];
	for (let i = months - 1; i >= 0; i -= 1) {
		const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
		const bucket = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
		const hit = found.get(bucket);
		out.push({ bucket, date, posts: hit?.posts ?? 0, notes: hit?.notes ?? 0 });
	}
	return out;
}

/** Same zero-fill as {@link fillMonths}, on a daily window. */
function fillDays(
	rows: CommentPoint[],
	now: Date,
	days: number
): Array<CommentPoint & { date: Date }> {
	const found = new Map(rows.map((row) => [row.bucket, row]));
	const out: Array<CommentPoint & { date: Date }> = [];
	for (let i = days - 1; i >= 0; i -= 1) {
		const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
		const bucket = date.toISOString().slice(0, 10);
		const hit = found.get(bucket);
		out.push({ bucket, date, total: hit?.total ?? 0, approved: hit?.approved ?? 0 });
	}
	return out;
}

/** Fail-open like the (site) layout: a settings blip renders "—" cards. */
async function readPresenceEnabled(): Promise<boolean> {
	try {
		return await getOption('presence.enabled');
	} catch {
		return true;
	}
}

/** Site timezone for the login timestamp; UTC keeps the dashboard usable. */
async function readSiteTimezone(): Promise<string> {
	try {
		const value = await getOption('site.timezone');
		return typeof value === 'string' && value.trim() !== '' ? value : 'UTC';
	} catch {
		return 'UTC';
	}
}

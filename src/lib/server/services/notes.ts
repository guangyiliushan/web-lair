import { and, count, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { notes, topics } from '$lib/server/db/content';
import { getOption } from '$lib/server/config/options-registry';
import { firstImageFromMarkdown, plainTextExcerpt } from '$lib/utils/excerpt';
import { noteDateLabel } from '$lib/utils/note-date';
import { NOTE_PAGE_SIZE } from '$lib/utils/note-meta';
import { visibleNoteCondition } from './note-visibility';

/**
 * Public notes read side (N1). Notes are diary entries: list cards derive
 * their summary and cover from the body, gated rows only ever expose the
 * title + lock, and the belongs-to date is derived per note (`tz`, falling
 * back to `site.timezone`). Decisions: ledger §13.9 / notes plan §8.
 */

/** Belongs-to date: `(published_at at time zone coalesce(tz, $site))::date`. */
function belongsToExpr(siteTz: string): SQL<unknown> {
	return sql`(${notes.publishedAt} at time zone coalesce(${notes.tz}, ${siteTz}))::date`;
}

export interface NoteCard {
	slug: string;
	title: string;
	publishedAt: Date;
	tz: string | null;
	locked: boolean;
	pinned: boolean;
	/** Derived prose excerpt; null for password-gated rows (never leaked). */
	excerpt: string | null;
	/** First body image URL; null for password-gated rows. */
	image: string | null;
}

export interface NoteCardSource {
	slug: string;
	title: string;
	publishedAt: Date | null;
	tz: string | null;
	content: string | null;
	passwordHash: string | null;
	pinAt: Date | null;
}

/**
 * Pure card projection (exported for tests): the single place that decides
 * what a locked row may expose. Gated rows must never ship derived content -
 * the excerpt/cover are body text and would leak the diary.
 */
export function toNoteCard(row: NoteCardSource): NoteCard | null {
	if (!row.publishedAt) return null;
	const locked = row.passwordHash !== null;
	return {
		slug: row.slug,
		title: row.title,
		publishedAt: row.publishedAt,
		tz: row.tz,
		locked,
		pinned: row.pinAt !== null,
		excerpt: locked ? null : plainTextExcerpt(row.content ?? ''),
		image: locked ? null : firstImageFromMarkdown(row.content ?? '')
	};
}

/** Route-facing list row (shared projection for the list and topic pages). */
export interface NoteListRow {
	slug: string;
	title: string;
	locked: boolean;
	excerpt: string | null;
	image: string | null;
	date: string;
}

/** Card to page-row projection: one place formats the belongs-to date (note
 * `tz`, site-timezone fallback) and keeps gated content hidden. */
export function toNoteRow(card: NoteCard, siteTz: string): NoteListRow {
	return {
		slug: card.slug,
		title: card.title,
		locked: card.locked,
		excerpt: card.excerpt,
		image: card.image,
		date: noteDateLabel(card.publishedAt, card.tz, siteTz)
	};
}

export interface NoteTopicOption {
	id: string;
	name: string;
	slug: string;
	icon: string | null;
	total: number;
}

export interface NotesListQuery {
	lang: string;
	page?: number;
	/** Belongs-to year filter (derived with the note's tz; site tz fallback). */
	year?: number | null;
	topicSlug?: string | null;
	/** Pre-resolved topic id: skips the slug lookup (topic pages pass it). */
	topicId?: string | null;
	/** Serve filter facets (the /notes list needs them; topic pages do not). */
	facets?: boolean;
	/** Caller-fetched site timezone; falls back to the options read. */
	siteTz?: string;
	now?: Date;
}

export interface NotesListResult {
	cards: NoteCard[];
	total: number;
	page: number;
	totalPages: number;
	/** Belongs-to years present among this language's visible notes (desc). */
	years: number[];
	/** Topics that carry visible notes in this language (curated order). */
	topics: NoteTopicOption[];
}

/** List page query: cards (pin-first), totals, and the two filter facets. */
export async function listNotes(query: NotesListQuery): Promise<NotesListResult> {
	const now = query.now ?? new Date();
	const siteTz = query.siteTz ?? (await getOption('site.timezone'));

	let condition = and(eq(notes.lang, query.lang), visibleNoteCondition(now)) as SQL<unknown>;
	// An unknown topic filter matches nothing (an empty list, not a silently
	// dropped filter); a known one narrows by topic id. A pre-resolved id
	// skips the slug lookup (topic pages already resolved the topic).
	let emptyTopic = false;
	const resolvedTopicId = query.topicId ?? null;
	if (resolvedTopicId) {
		condition = and(condition, eq(notes.topicId, resolvedTopicId)) as SQL<unknown>;
	} else if (query.topicSlug) {
		const topic = await findTopicBySlug(query.topicSlug);
		if (topic) condition = and(condition, eq(notes.topicId, topic.id)) as SQL<unknown>;
		else emptyTopic = true;
	}
	if (typeof query.year === 'number' && Number.isFinite(query.year))
		condition = and(
			condition,
			sql`date_part('year', ${belongsToExpr(siteTz)}) = ${query.year}`
		) as SQL<unknown>;

	let total = 0;
	if (!emptyTopic) {
		const [totals] = await db.select({ total: count() }).from(notes).where(condition);
		total = totals?.total ?? 0;
	}
	const totalPages = Math.max(1, Math.ceil(total / NOTE_PAGE_SIZE));
	const requested =
		query.page === undefined || Number.isNaN(query.page) ? 1 : Math.trunc(query.page);
	const page = Math.min(Math.max(requested, 1), totalPages);

	let cards: NoteCard[] = [];
	if (!emptyTopic) {
		const rows = await db
			.select({
				slug: notes.slug,
				title: notes.title,
				publishedAt: notes.publishedAt,
				tz: notes.tz,
				content: notes.content,
				passwordHash: notes.passwordHash,
				pinAt: notes.pinAt
			})
			.from(notes)
			.where(condition)
			.orderBy(sql`${notes.pinAt} desc nulls last`, desc(notes.publishedAt), desc(notes.id))
			.limit(NOTE_PAGE_SIZE)
			.offset((page - 1) * NOTE_PAGE_SIZE);

		cards = rows.flatMap((row) => {
			const card = toNoteCard(row);
			return card ? [card] : [];
		});
	}

	// Facets: belongs-to years and per-language topic counts (only topics
	// that actually carry visible notes are offered as filters). Topic pages
	// set `facets: false` - they discard both.
	const years = query.facets === false ? [] : await listNoteYears(query.lang, now, siteTz);
	const topicOptions = query.facets === false ? [] : await listTopicOptions(query.lang, now);

	return {
		cards,
		total,
		page,
		totalPages,
		years,
		topics: topicOptions
	};
}

/** Belongs-to years present among a language's visible notes (newest first). */
export async function listNoteYears(lang: string, now: Date, siteTz: string): Promise<number[]> {
	// `.as('year')` is load-bearing: drizzle emits ` as "name"` only for
	// SQL.Aliased, and a plain sql field leaves `order by "year"` referencing
	// a select-list column that does not exist (42703 on real PG - review
	// round 2; the earlier mock tests could not see the render-level bug).
	const yearExpr = sql<number>`date_part('year', ${belongsToExpr(siteTz)})::int`.as('year');
	const rows = await db
		.selectDistinct({ year: yearExpr })
		.from(notes)
		.where(and(eq(notes.lang, lang), visibleNoteCondition(now)))
		// Order by the OUTPUT alias: a SELECT DISTINCT requires ORDER BY
		// expressions to appear in the select list (hence the `.as('year')`
		// above), and re-rendering the parameterized expression instead would
		// bind `$site` twice (review rounds 1-2, real-PG findings).
		.orderBy(sql`"year" desc`);
	return rows.map((row) => row.year);
}

/** Topics that carry visible notes in one language (curated order). */
export async function listTopicOptions(lang: string, now: Date): Promise<NoteTopicOption[]> {
	const rows = await db
		.select({
			id: topics.id,
			name: topics.name,
			slug: topics.slug,
			icon: topics.icon,
			total: count(notes.id)
		})
		.from(topics)
		.leftJoin(
			notes,
			and(eq(notes.topicId, topics.id), eq(notes.lang, lang), visibleNoteCondition(now))
		)
		.groupBy(topics.id)
		.orderBy(topics.sortOrder, topics.name);
	return rows.filter((row) => row.total > 0);
}

/** Count of visible notes in one language (mega-menu footer). */
export async function countVisibleNotes(lang: string, now: Date = new Date()): Promise<number> {
	const [row] = await db
		.select({ total: count() })
		.from(notes)
		.where(and(eq(notes.lang, lang), visibleNoteCondition(now)));
	return row?.total ?? 0;
}

export interface NoteTopic {
	id: string;
	name: string;
	slug: string;
	icon: string | null;
	description: string;
	sortOrder: number;
}

/** Topic lookup for the `/{lang}/notes/topics/[slug]` page (404 when absent). */
export async function findTopicBySlug(slug: string): Promise<NoteTopic | null> {
	const [row] = await db
		.select({
			id: topics.id,
			name: topics.name,
			slug: topics.slug,
			icon: topics.icon,
			description: topics.description,
			sortOrder: topics.sortOrder
		})
		.from(topics)
		.where(eq(topics.slug, slug))
		.limit(1);
	return row ?? null;
}

export interface NoteDetailRow {
	id: string;
	nid: number;
	slug: string;
	title: string;
	/**
	 * Body markdown, shipped ONLY for open rows. A password-gated row keeps
	 * `null` here even before the unlock check, so a forgotten gate cannot
	 * leak the diary into SSR data - the gate renders the body through
	 * `getNoteBody` after a verified unlock (review finding).
	 */
	content: string | null;
	lang: string;
	tz: string | null;
	mood: string | null;
	/** Emotion tokens from `meta.emotions` (closed Apple vocabulary). */
	emotions: string[] | null;
	weatherCode: number | null;
	temperatureC: string | null;
	coordinates: { latitude: number; longitude: number } | null;
	location: string | null;
	publishedAt: Date;
	pinAt: Date | null;
	allowComment: boolean;
	/** True when a password gate is armed; the hash itself never travels with
	 * page data - the gate reads it through `getNoteGateRecord`. */
	locked: boolean;
	translationGroup: string;
	topic: { name: string; slug: string; icon: string | null } | null;
}

/** Detail row for one (lang, slug); null when invisible or missing. */
export async function findVisibleNote(
	lang: string,
	slug: string,
	now: Date = new Date()
): Promise<NoteDetailRow | null> {
	const [row] = await db
		.select({
			id: notes.id,
			nid: notes.nid,
			slug: notes.slug,
			title: notes.title,
			content: notes.content,
			lang: notes.lang,
			tz: notes.tz,
			mood: notes.mood,
			weatherCode: notes.weatherCode,
			temperatureC: notes.temperatureC,
			coordinates: notes.coordinates,
			location: notes.location,
			publishedAt: notes.publishedAt,
			pinAt: notes.pinAt,
			allowComment: notes.allowComment,
			passwordHash: notes.passwordHash,
			meta: notes.meta,
			translationGroup: notes.translationGroup,
			topicName: topics.name,
			topicSlug: topics.slug,
			topicIcon: topics.icon
		})
		.from(notes)
		.leftJoin(topics, eq(notes.topicId, topics.id))
		.where(and(eq(notes.lang, lang), eq(notes.slug, slug), visibleNoteCondition(now)))
		.limit(1);
	if (!row || !row.publishedAt) return null;

	const locked = row.passwordHash !== null;
	// Locked rows ship the public shell only (title/slug/topic/dates): the
	// body AND the diary metadata (mood/weather/location/emotions/tz) are
	// withheld until a verified unlock - SSR page data is visible in the
	// HTML source, so "hidden by the UI" would not be hidden at all.
	return {
		id: row.id,
		nid: row.nid,
		slug: row.slug,
		title: row.title,
		content: locked ? null : row.content,
		lang: row.lang,
		tz: locked ? null : row.tz,
		mood: locked ? null : row.mood,
		emotions: locked ? null : (row.meta?.emotions ?? null),
		weatherCode: locked ? null : row.weatherCode,
		temperatureC: locked ? null : row.temperatureC,
		coordinates: locked ? null : row.coordinates,
		location: locked ? null : row.location,
		publishedAt: row.publishedAt,
		pinAt: row.pinAt,
		allowComment: row.allowComment,
		locked,
		translationGroup: row.translationGroup,
		topic: row.topicSlug
			? { name: row.topicName ?? '', slug: row.topicSlug, icon: row.topicIcon }
			: null
	};
}

/** Gate-only read: the stored password hash for one note (ids resolve after
 * `findVisibleNote` already accepted the row). Never spread into page data. */
export async function getNoteGateRecord(
	noteId: string
): Promise<{ id: string; passwordHash: string | null } | null> {
	const [row] = await db
		.select({ id: notes.id, passwordHash: notes.passwordHash })
		.from(notes)
		.where(eq(notes.id, noteId))
		.limit(1);
	return row ?? null;
}

/** Body read for gated rows after a verified unlock (locked bodies stay out
 * of `findVisibleNote` on purpose - see NoteDetailRow.content). */
export async function getNoteBody(noteId: string): Promise<string | null> {
	const [row] = await db
		.select({ content: notes.content })
		.from(notes)
		.where(eq(notes.id, noteId))
		.limit(1);
	return row?.content ?? null;
}

/** Other languages that have the same slug visible (404 hint query). */
export async function listVisibleNoteLanguages(
	slug: string,
	excludeLang: string,
	now: Date = new Date()
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ lang: notes.lang })
		.from(notes)
		.where(and(eq(notes.slug, slug), ne(notes.lang, excludeLang), visibleNoteCondition(now)));
	return rows.map((row) => row.lang);
}

/** Visible versions of one translation group (hreflang alternates). */
export async function listVisibleGroupVersions(
	translationGroup: string,
	now: Date = new Date()
): Promise<Array<{ lang: string; slug: string }>> {
	return db
		.select({ lang: notes.lang, slug: notes.slug })
		.from(notes)
		.where(and(eq(notes.translationGroup, translationGroup), visibleNoteCondition(now)));
}

export interface NoteSummary {
	id: string;
	slug: string;
	title: string;
	publishedAt: Date;
	tz: string | null;
	locked: boolean;
}

/** Recent visible notes (mega menu, timeline join; gated rows included). */
export async function listNoteSummaries(
	lang: string,
	options: { limit?: number; now?: Date } = {}
): Promise<NoteSummary[]> {
	const now = options.now ?? new Date();
	const base = db
		.select({
			id: notes.id,
			slug: notes.slug,
			title: notes.title,
			publishedAt: notes.publishedAt,
			tz: notes.tz,
			passwordHash: notes.passwordHash
		})
		.from(notes)
		.where(and(eq(notes.lang, lang), visibleNoteCondition(now)))
		.orderBy(desc(notes.publishedAt), desc(notes.id));
	const rows = options.limit ? await base.limit(options.limit) : await base;
	return rows.flatMap((row) =>
		row.publishedAt
			? [
					{
						id: row.id,
						slug: row.slug,
						title: row.title,
						publishedAt: row.publishedAt,
						tz: row.tz,
						locked: row.passwordHash !== null
					}
				]
			: []
	);
}

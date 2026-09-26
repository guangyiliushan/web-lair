import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, drafts, postRevisions, postTags, posts, tags } from '$lib/server/db/content';
import { slugTrackers } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { tagSlug } from '$lib/utils/slug';
import { parseTags, SLUG_RE } from './posts';

/**
 * Draft-flow service (P2, ledger §9.10 / §9.14.2-3): the editor never writes
 * posts content directly - it upserts a single `drafts` row per target and the
 * publish transaction copies it onto `posts`. Everything that both the editor
 * routes and tests need lives here.
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Marker for the auto-generated slug of never-published placeholder rows. */
const PLACEHOLDER_SLUG_PREFIX = 'draft-';

export function isPlaceholderSlug(slug: string): boolean {
	return slug.startsWith(PLACEHOLDER_SLUG_PREFIX);
}

/** Unique-enough placeholder slug; the real slug is required at publish. */
export function tempSlug(): string {
	return `${PLACEHOLDER_SLUG_PREFIX}${randomBytes(5).toString('hex')}`;
}

/** Server-side minimum interval between autosave writes for one draft (§9.10). */
export const DRAFT_THROTTLE_MS = 30_000;

export interface DraftPayload {
	title: string;
	slug: string;
	categoryId: string;
	summary: string;
	tags: string;
	content: string;
}

interface NormalizedDraft {
	title: string;
	slug: string;
	categoryId: string;
	summary: string;
	tags: string[];
	content: string;
}

function normalizePayload(payload: DraftPayload): NormalizedDraft {
	return {
		title: payload.title ?? '',
		slug: payload.slug ?? '',
		categoryId: payload.categoryId ?? '',
		summary: payload.summary ?? '',
		tags: parseTags(payload.tags),
		content: payload.content ?? ''
	};
}

/** The "hash 不变不写" comparison basis (§9.10) - payload vs stored row. */
export function draftHash(payload: DraftPayload): string {
	return hashNormalized(normalizePayload(payload));
}

function hashNormalized(value: NormalizedDraft): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				value.title,
				value.slug,
				value.categoryId,
				value.summary,
				value.tags,
				value.content
			])
		)
		.digest('hex');
}

type DraftRow = typeof drafts.$inferSelect;

function hashRow(row: DraftRow): string {
	return hashNormalized({
		title: row.title,
		slug: row.slug ?? '',
		categoryId: row.categoryId ?? '',
		summary: row.summary ?? '',
		tags: row.tags ?? [],
		content: row.content ?? ''
	});
}

/** Replace a post's tags inside the caller's transaction (moved from the editor in P2). */
export async function syncPostTags(executor: DbExecutor, postId: string, names: string[]) {
	await executor.delete(postTags).where(eq(postTags.postId, postId));
	for (const name of names) {
		const slug = tagSlug(name);
		const [tag] = await executor
			.insert(tags)
			.values({ name, slug })
			.onConflictDoUpdate({ target: tags.slug, set: { name: sql`${tags.name}` } })
			.returning({ id: tags.id });
		await executor.insert(postTags).values({ postId, tagId: tag.id }).onConflictDoNothing();
	}
}

export async function loadDraftById(draftId: string): Promise<DraftRow | null> {
	const [row] = await db
		.select()
		.from(drafts)
		.where(and(eq(drafts.id, draftId), eq(drafts.refType, 'post')))
		.limit(1);
	return row ?? null;
}

export async function loadDraftByPostId(postId: string): Promise<DraftRow | null> {
	const [row] = await db
		.select()
		.from(drafts)
		.where(and(eq(drafts.refType, 'post'), eq(drafts.refId, postId)))
		.limit(1);
	return row ?? null;
}

/* ── Save (autosave + manual share one path) ─────────────────────────── */

export type SaveDraftResult =
	| { kind: 'saved'; draftId: string; version: number; postId: string; updatedAt: Date | null }
	| { kind: 'unchanged'; draftId: string; version: number; postId: string }
	| { kind: 'throttled'; draftId: string; version: number; postId: string }
	| {
			kind: 'conflict';
			server: { draftId: string | null; version: number; updatedAt: Date | null };
	  }
	| { kind: 'needs-category' }
	| { kind: 'not-found' }
	| { kind: 'duplicate' };

export interface SaveDraftInput {
	/** Draft row address (preferred once the client has one). */
	draftId?: string | null;
	/** Posts id (existing article, or absent for a brand-new article). */
	postId?: string | null;
	/** Draft version the client last saw (optimistic lock, §9.10). */
	expectedVersion?: number | null;
	/** Language for a brand-new article (picker; the placeholder row stores it). */
	lang?: string | null;
	payload: DraftPayload;
	author?: string | null;
	/** Autosave skips the 30s server throttle; manual saves always go through. */
	autosave: boolean;
}

function draftUpdateSet(payload: NormalizedDraft) {
	return {
		title: payload.title,
		slug: payload.slug === '' ? null : payload.slug,
		categoryId: payload.categoryId === '' ? null : payload.categoryId,
		tags: payload.tags,
		content: payload.content,
		contentFormat: 'markdown',
		summary: payload.summary === '' ? null : payload.summary
	};
}

export async function saveDraftWork(input: SaveDraftInput): Promise<SaveDraftResult> {
	const payload = normalizePayload(input.payload);

	// Address by draft row first (covers both new placeholders and edits).
	if (input.draftId) {
		const draft = await loadDraftById(input.draftId);
		if (!draft) {
			// The row is gone: it was published or discarded elsewhere.
			return { kind: 'conflict', server: { draftId: null, version: 0, updatedAt: null } };
		}
		return updateExistingDraft(draft, payload, input);
	}

	if (input.postId) {
		const existing = await loadDraftByPostId(input.postId);
		if (existing) return updateExistingDraft(existing, payload, input);

		const [post] = await db
			.select({ id: posts.id, version: posts.version })
			.from(posts)
			.where(eq(posts.id, input.postId))
			.limit(1);
		if (!post) return { kind: 'not-found' };
		try {
			const [created] = await db
				.insert(drafts)
				.values({
					refType: 'post',
					refId: post.id,
					...draftUpdateSet(payload),
					version: 1,
					baseVersion: post.version,
					author: input.author ?? null,
					// Application-level updated_at (§9.7): the column has no
					// DB default and $onUpdate only runs on updates.
					updatedAt: new Date()
				})
				.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
			return {
				kind: 'saved',
				draftId: created.id,
				version: created.version,
				postId: post.id,
				updatedAt: created.updatedAt
			};
		} catch (caught) {
			// A concurrent tab created the draft first - surface it as a conflict.
			if (pgErrorCode(caught) === '23505') {
				const server = await loadDraftByPostId(input.postId);
				return {
					kind: 'conflict',
					server: {
						draftId: server?.id ?? null,
						version: server?.version ?? 0,
						updatedAt: server?.updatedAt ?? null
					}
				};
			}
			throw caught;
		}
	}

	// Brand-new article: the first save materializes the placeholder posts row
	// (§9.10 - WP auto-draft style). The posts row requires a category, so the
	// editor holds the session in memory until one is picked.
	if (!payload.categoryId) return { kind: 'needs-category' };
	const lang = input.lang ?? 'en';

	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const result = await db.transaction(async (tx) => {
				const [createdPost] = await tx
					.insert(posts)
					.values({
						title: payload.title,
						slug: tempSlug(),
						lang,
						categoryId: payload.categoryId,
						status: 'draft',
						version: 0,
						// posts.updated_at has no DB default either (see §9.7 note above).
						updatedAt: new Date()
					})
					.returning({ id: posts.id });
				const [createdDraft] = await tx
					.insert(drafts)
					.values({
						refType: 'post',
						refId: createdPost.id,
						...draftUpdateSet(payload),
						version: 1,
						baseVersion: 0,
						author: input.author ?? null,
						updatedAt: new Date()
					})
					.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
				return { postId: createdPost.id, draft: createdDraft };
			});
			return {
				kind: 'saved',
				draftId: result.draft.id,
				version: result.draft.version,
				postId: result.postId,
				updatedAt: result.draft.updatedAt
			};
		} catch (caught) {
			// Placeholder slug collision (extremely unlikely): retry with a new one.
			if (pgErrorCode(caught) === '23505' && attempt < 2) continue;
			throw caught;
		}
	}
	throw new Error('draft placeholder creation failed');
}

async function updateExistingDraft(
	draft: DraftRow,
	payload: NormalizedDraft,
	input: SaveDraftInput
): Promise<SaveDraftResult> {
	const postId = draft.refId ?? '';

	// "hash 不变不写" - identical payloads never bump the version.
	if (hashRow(draft) === hashNormalized(payload)) {
		return { kind: 'unchanged', draftId: draft.id, version: draft.version, postId };
	}

	// Autosave throttle: at most one write per draft per 30s (§9.10). Manual
	// saves bypass it; the client retries while still dirty.
	const lastWrite = draft.updatedAt?.getTime() ?? 0;
	if (input.autosave && Date.now() - lastWrite < DRAFT_THROTTLE_MS) {
		return { kind: 'throttled', draftId: draft.id, version: draft.version, postId };
	}

	// Optimistic lock: the client's base version must still be current.
	if (input.expectedVersion != null && draft.version !== input.expectedVersion) {
		return {
			kind: 'conflict',
			server: { draftId: draft.id, version: draft.version, updatedAt: draft.updatedAt }
		};
	}

	const expected = input.expectedVersion ?? draft.version;
	const updated = await db
		.update(drafts)
		.set({ ...draftUpdateSet(payload), version: draft.version + 1, updatedAt: new Date() })
		.where(and(eq(drafts.id, draft.id), eq(drafts.version, expected)))
		.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });

	if (updated.length === 0) {
		// Lost the conditional update to a concurrent save.
		const server = await loadDraftById(draft.id);
		return {
			kind: 'conflict',
			server: {
				draftId: server?.id ?? null,
				version: server?.version ?? 0,
				updatedAt: server?.updatedAt ?? null
			}
		};
	}
	return {
		kind: 'saved',
		draftId: updated[0].id,
		version: updated[0].version,
		postId,
		updatedAt: updated[0].updatedAt
	};
}

/* ── Publish transaction (§9.2 / §9.8 / §9.12 / §9.14.2) ─────────────── */

export type PublishResult =
	| { kind: 'published'; postId: string; version: number }
	| { kind: 'conflict'; server: { version: number } }
	| { kind: 'not-found' }
	| { kind: 'invalid'; errors: Record<string, string> }
	| { kind: 'slug-taken' };

export async function publishDraft(
	draftId: string,
	author?: string | null
): Promise<PublishResult> {
	const draft = await loadDraftById(draftId);
	if (!draft || !draft.refId) return { kind: 'not-found' };

	const [post] = await db.select().from(posts).where(eq(posts.id, draft.refId)).limit(1);
	if (!post) return { kind: 'not-found' };

	const errors: Record<string, string> = {};
	const title = draft.title.trim();
	const slug = (draft.slug ?? '').trim();
	const categoryId = draft.categoryId ?? '';
	if (!title) errors.title = '标题不能为空';
	if (!slug) errors.slug = 'Slug 不能为空';
	else if (!SLUG_RE.test(slug)) errors.slug = 'Slug 仅允许小写英文、数字和连字符';
	if (!categoryId) errors.categoryId = '请选择分类';
	if (!(draft.content ?? '').trim()) errors.content = '正文不能为空';
	if (Object.keys(errors).length > 0) return { kind: 'invalid', errors };

	if (categoryId) {
		const [category] = await db
			.select({ id: categories.id })
			.from(categories)
			.where(eq(categories.id, categoryId))
			.limit(1);
		if (!category) return { kind: 'invalid', errors: { categoryId: '分类不存在' } };
	}

	try {
		return await db.transaction(async (tx) => {
			const [locked] = await tx
				.select()
				.from(posts)
				.where(eq(posts.id, post.id))
				.limit(1)
				.for('update');
			if (!locked) return { kind: 'not-found' as const };

			// Optimistic base check: fail when the article moved on meanwhile
			// (another tab published), never silently overwrite (§9.10, 情景16).
			if (locked.version !== draft.baseVersion) {
				return { kind: 'conflict' as const, server: { version: locked.version } };
			}

			// Slug change inside the same language: keep the old slug resolvable.
			if (locked.slug !== slug && !isPlaceholderSlug(locked.slug)) {
				await tx.insert(slugTrackers).values({
					slug: locked.slug,
					type: 'post',
					lang: locked.lang,
					targetId: locked.id
				});
			}

			const nextVersion = locked.version + 1;
			await tx
				.update(posts)
				.set({
					title,
					slug,
					categoryId,
					content: draft.content,
					contentFormat: draft.contentFormat,
					summary: draft.summary,
					status: 'published',
					publishedAt: sql`coalesce(${posts.publishedAt}, now())`,
					version: nextVersion,
					updatedAt: new Date()
				})
				.where(eq(posts.id, locked.id));

			await tx.insert(postRevisions).values({
				postId: locked.id,
				version: nextVersion,
				title,
				content: draft.content,
				summary: draft.summary,
				source: 'publish',
				author: author ?? null
			});

			await syncPostTags(tx, locked.id, draft.tags ?? []);

			await tx.delete(drafts).where(eq(drafts.id, draft.id));

			return { kind: 'published' as const, postId: locked.id, version: nextVersion };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		if (code === '23505') return { kind: 'slug-taken' };
		if (code === '23503') return { kind: 'invalid', errors: { categoryId: '分类不存在' } };
		throw caught;
	}
}

/* ── Discard (§9.14.3) ───────────────────────────────────────────────── */

export type DiscardResult =
	{ kind: 'discarded'; postId: string | null; removedPlaceholder: boolean } | { kind: 'not-found' };

export async function discardDraft(draftId: string): Promise<DiscardResult> {
	return db.transaction(async (tx) => {
		const [draft] = await tx
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.refType, 'post')))
			.limit(1);
		if (!draft) return { kind: 'not-found' as const };

		await tx.delete(drafts).where(eq(drafts.id, draft.id));

		let removedPlaceholder = false;
		if (draft.refId) {
			const [post] = await tx
				.select({ id: posts.id, status: posts.status, version: posts.version })
				.from(posts)
				.where(eq(posts.id, draft.refId))
				.limit(1);
			// A never-published placeholder goes with its draft (§9.14.3).
			if (post && post.version === 0 && post.status === 'draft') {
				await tx.delete(posts).where(eq(posts.id, post.id));
				removedPlaceholder = true;
			}
		}
		return { kind: 'discarded' as const, postId: draft.refId, removedPlaceholder };
	});
}

/* ── Create translation (§9.20.4) ────────────────────────────────────── */

export type CreateTranslationResult =
	| { kind: 'created'; postId: string }
	| { kind: 'not-found' }
	| { kind: 'same-lang' }
	| { kind: 'lang-exists' };

export async function createTranslationDraft(
	sourceId: string,
	lang: string,
	author?: string | null
): Promise<CreateTranslationResult> {
	const [source] = await db.select().from(posts).where(eq(posts.id, sourceId)).limit(1);
	if (!source) return { kind: 'not-found' };
	if (source.lang === lang) return { kind: 'same-lang' };

	const [sibling] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.translationGroup, source.translationGroup), eq(posts.lang, lang)))
		.limit(1);
	if (sibling) return { kind: 'lang-exists' };

	return db.transaction(async (tx) => {
		const [created] = await tx
			.insert(posts)
			.values({
				// Copy prefill (§9.20.4): title/content/summary ride in the draft
				// row; the placeholder keeps the identity columns only.
				title: source.title,
				slug: tempSlug(),
				lang,
				translationGroup: source.translationGroup,
				translatedFromPostId: source.id,
				categoryId: source.categoryId,
				status: 'draft',
				version: 0,
				updatedAt: new Date()
			})
			.returning({ id: posts.id });

		await tx.insert(drafts).values({
			refType: 'post',
			refId: created.id,
			title: source.title,
			slug: null,
			categoryId: source.categoryId,
			tags: [],
			content: source.content,
			contentFormat: source.contentFormat ?? 'markdown',
			summary: source.summary,
			version: 1,
			baseVersion: 0,
			author: author ?? null,
			updatedAt: new Date()
		});

		return { kind: 'created' as const, postId: created.id };
	});
}

/* ── Read helpers for the lists ──────────────────────────────────────── */

/** Posts that already have a pending (unpublished) draft - list badge. */
export async function draftsForPosts(postIds: string[]): Promise<Set<string>> {
	if (postIds.length === 0) return new Set();
	const rows = await db
		.select({ refId: drafts.refId })
		.from(drafts)
		.where(and(eq(drafts.refType, 'post'), inArray(drafts.refId, postIds)));
	return new Set(rows.map((r) => r.refId).filter((id): id is string => id != null));
}

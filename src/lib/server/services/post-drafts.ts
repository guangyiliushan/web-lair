import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { categories, drafts, postRevisions, postTags, posts, tags } from '$lib/server/db/content';
import {
	normalizeProvenance,
	postProvenanceFromPayload,
	provenanceEquals,
	type PostProvenanceDraft
} from '$lib/server/db/content/post-provenance';
import { slugTrackers } from '$lib/server/db/system';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { keysFromContent, syncFileReferences } from './file-references';
import { tagSlug } from '$lib/utils/slug';
import { parseTags, SLUG_RE } from './posts';
import { m } from '$lib/paraglide/messages';

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
	provenance?: PostProvenanceDraft | null;
}

interface NormalizedDraft {
	title: string;
	slug: string;
	categoryId: string;
	summary: string;
	tags: string[];
	content: string;
	provenance: PostProvenanceDraft | null;
}

/** CRLF (and lone CR) to LF - the one canonicalization point for drafts. */
function canonicalLf(value: string): string {
	return value.replace(/\r\n?/g, '\n');
}

function normalizePayload(payload: DraftPayload): NormalizedDraft {
	return {
		title: payload.title ?? '',
		slug: payload.slug ?? '',
		categoryId: payload.categoryId ?? '',
		summary: payload.summary ?? '',
		tags: parseTags(payload.tags),
		// Canonical LF at the service entry (3b1 review 05-P3-6): FormData
		// submits CRLF-normalized text and the hash basis below hashes this
		// exact value - normalizing here keeps hash and stored row in sync
		// and makes the stored content the canonical shape for imports.
		content: canonicalLf(payload.content ?? ''),
		provenance: payload.provenance ? normalizeProvenance(payload.provenance) : null
	};
}

/** The "hash 不变不写" comparison basis (§9.10) - payload vs stored row. */
export function draftHash(payload: DraftPayload): string {
	return hashNormalized(normalizePayload(payload));
}

/**
 * Hash the exact write set (single source of truth): any change that
 * `draftUpdateSet` persists is by construction part of the hash, so a new
 * editable field can never silently skip the "unchanged" fast path.
 */
function hashNormalized(value: NormalizedDraft): string {
	return createHash('sha256')
		.update(JSON.stringify(draftUpdateSet(value)))
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
		content: row.content ?? '',
		provenance: postProvenanceFromPayload(row.payload)
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
	| { kind: 'throttled'; draftId: string; version: number; postId: string; retryAfterMs: number }
	| {
			kind: 'conflict';
			server: { draftId: string | null; version: number; updatedAt: Date | null };
	  }
	| { kind: 'needs-category' }
	| { kind: 'not-found' };

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
		summary: payload.summary === '' ? null : payload.summary,
		payload: payload.provenance ? { provenance: payload.provenance } : null
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
			// Attaching the first draft to published content is a save path
			// too: the content write and the reference diff share one
			// transaction (Q15), the submitted body being the desired set.
			const created = await db.transaction(async (tx) => {
				const [row] = await tx
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
				// Draft identity (3b2): the published post's ref set keeps
				// describing the published body until publish re-keys it.
				await syncFileReferences(
					tx,
					{ type: 'draft', id: row.id },
					keysFromContent(payload.content)
				);
				return row;
			});
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
				// References ride the materialization transaction (Q15), keyed
				// on the draft's own identity (3b2).
				await syncFileReferences(
					tx,
					{ type: 'draft', id: createdDraft.id },
					keysFromContent(payload.content)
				);
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
	// saves bypass it; the client retries while still dirty using the
	// `retryAfterMs` hint we return here (never guess the window length).
	const lastWrite = draft.updatedAt?.getTime() ?? 0;
	const elapsed = Date.now() - lastWrite;
	if (input.autosave && elapsed < DRAFT_THROTTLE_MS) {
		return {
			kind: 'throttled',
			draftId: draft.id,
			version: draft.version,
			postId,
			retryAfterMs: DRAFT_THROTTLE_MS - elapsed
		};
	}

	// Optimistic lock: the client's base version must still be current.
	if (input.expectedVersion != null && draft.version !== input.expectedVersion) {
		return {
			kind: 'conflict',
			server: { draftId: draft.id, version: draft.version, updatedAt: draft.updatedAt }
		};
	}

	const expected = input.expectedVersion ?? draft.version;
	// Content write + reference diff share one transaction (Q15); the
	// hash/unchanged gate above is the autosave short-circuit (Q6) - a no-op
	// autosave never re-scans the content.
	const updated = await db.transaction(async (tx) => {
		const rows = await tx
			.update(drafts)
			.set({ ...draftUpdateSet(payload), version: draft.version + 1, updatedAt: new Date() })
			.where(and(eq(drafts.id, draft.id), eq(drafts.version, expected)))
			.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
		if (rows.length > 0) {
			// Draft identity (3b2): the working copy's refs never touch the
			// published set.
			await syncFileReferences(
				tx,
				{ type: 'draft', id: draft.id },
				keysFromContent(payload.content)
			);
		}
		return rows;
	});

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
	| { kind: 'slug-taken' }
	/** Deadlock/serialization failure between concurrent admin actions. */
	| { kind: 'busy' };

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
	if (!title) errors.title = m.admin_editor_err_title_required();
	if (!slug) errors.slug = m.admin_editor_err_slug_required();
	else if (!SLUG_RE.test(slug)) errors.slug = m.admin_posts_edit_err_slug_charset();
	else if (slug.startsWith(PLACEHOLDER_SLUG_PREFIX))
		errors.slug = m.admin_editor_err_slug_reserved_prefix();
	if (!categoryId) errors.categoryId = m.admin_posts_edit_err_category_required();
	if (!(draft.content ?? '').trim()) errors.content = m.admin_editor_err_content_required();
	if (Object.keys(errors).length > 0) return { kind: 'invalid', errors };

	if (categoryId) {
		const [category] = await db
			.select({ id: categories.id })
			.from(categories)
			.where(eq(categories.id, categoryId))
			.limit(1);
		if (!category)
			return { kind: 'invalid', errors: { categoryId: m.admin_posts_edit_err_category_missing() } };
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

			// Lock the working copy too, in the SAME order as discardDraft
			// (posts → drafts) so the two admin actions cannot deadlock, and
			// publish the locked rows: a concurrent save that lands between the
			// outer snapshot and this transaction must not be silently lost.
			const [lockedDraft] = await tx
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, draft.id), eq(drafts.refType, 'post')))
				.limit(1)
				.for('update');
			if (!lockedDraft) return { kind: 'not-found' as const };

			// Optimistic base check: fail when the article moved on meanwhile
			// (another tab published), never silently overwrite (§9.10, 情景16).
			if (locked.version !== lockedDraft.baseVersion) {
				return { kind: 'conflict' as const, server: { version: locked.version } };
			}

			const finalTitle = lockedDraft.title.trim();
			const finalSlug = (lockedDraft.slug ?? '').trim();
			const finalCategoryId = lockedDraft.categoryId ?? '';
			// Provenance is staged in the draft payload; an absent payload means
			// "this draft predates provenance", so preserve the published values.
			// A value-identical payload must not bump the audit timestamp.
			// Translations never carry their own writing/visual claim: the source
			// is authoritative. Ignore any staged provenance on a translation
			// (the disabled UI is not an authorization boundary).
			const provenance = locked.translatedFromPostId
				? null
				: postProvenanceFromPayload(lockedDraft.payload);
			const publishedProvenance = normalizeProvenance({
				writingOrigin: locked.writingOrigin,
				visualOrigin: locked.visualOrigin,
				aiHelp: locked.aiHelp ?? []
			});
			const provenanceChanged =
				provenance !== null && !provenanceEquals(provenance, publishedProvenance);
			if (!finalTitle || !finalSlug || !finalCategoryId || !(lockedDraft.content ?? '').trim()) {
				return {
					kind: 'invalid' as const,
					errors: { form: m.admin_editor_err_stale_draft() } as Record<string, string>
				};
			}
			if (!SLUG_RE.test(finalSlug) || finalSlug.startsWith(PLACEHOLDER_SLUG_PREFIX)) {
				return {
					kind: 'invalid' as const,
					errors: { slug: m.admin_editor_err_slug_invalid() } as Record<string, string>
				};
			}

			// Slug change inside the same language: keep the old slug resolvable.
			if (locked.slug !== finalSlug && !isPlaceholderSlug(locked.slug)) {
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
					title: finalTitle,
					slug: finalSlug,
					categoryId: finalCategoryId,
					content: lockedDraft.content,
					contentFormat: lockedDraft.contentFormat,
					summary: lockedDraft.summary,
					status: 'published',
					publishedAt: sql`coalesce(${posts.publishedAt}, now())`,
					version: nextVersion,
					updatedAt: new Date(),
					...(provenanceChanged && provenance
						? {
								writingOrigin: provenance.writingOrigin,
								visualOrigin: provenance.visualOrigin,
								aiHelp: provenance.aiHelp,
								provenanceSource: 'author' as const,
								provenanceUpdatedAt: sql`now()`,
								provenanceUpdatedBy: author ?? null
							}
						: {})
				})
				.where(eq(posts.id, locked.id));

			await tx.insert(postRevisions).values({
				postId: locked.id,
				version: nextVersion,
				title: finalTitle,
				content: lockedDraft.content,
				summary: lockedDraft.summary,
				source: 'publish',
				author: author ?? null
			});

			await syncPostTags(tx, locked.id, lockedDraft.tags ?? []);

			await tx.delete(drafts).where(eq(drafts.id, lockedDraft.id));

			// The published body's key set is the durable reference set
			// (Q15: same transaction as the content write).
			await syncFileReferences(
				tx,
				{ type: 'post', id: locked.id },
				keysFromContent(lockedDraft.content)
			);
			// The draft's own refs leave with the draft row (3b2: full clear).
			await syncFileReferences(tx, { type: 'draft', id: lockedDraft.id }, []);

			return { kind: 'published' as const, postId: locked.id, version: nextVersion };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		if (code === '23505') return { kind: 'slug-taken' };
		if (code === '23503')
			return { kind: 'invalid', errors: { categoryId: m.admin_posts_edit_err_category_missing() } };
		// Deadlock/serialization failures are retryable admin-action conflicts.
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

/* ── Discard (§9.14.3) ───────────────────────────────────────────────── */

export type DiscardResult =
	| { kind: 'discarded'; postId: string | null; removedPlaceholder: boolean }
	| { kind: 'not-found' }
	/** Deadlock/serialization failure between concurrent admin actions. */
	| { kind: 'busy' };

export async function discardDraft(draftId: string): Promise<DiscardResult> {
	try {
		return await db.transaction(async (tx) => {
			const [draft] = await tx
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, draftId), eq(drafts.refType, 'post')))
				.limit(1);
			if (!draft) return { kind: 'not-found' as const };

			if (draft.refId) {
				// Lock order matches publishDraft (posts → drafts) so a publish
				// and a discard on the same target cannot deadlock; the seed row
				// is then re-checked on the locked post, not check-then-act.
				const [post] = await tx
					.select({
						id: posts.id,
						status: posts.status,
						version: posts.version,
						content: posts.content
					})
					.from(posts)
					.where(eq(posts.id, draft.refId))
					.limit(1)
					.for('update');
				const deleted = await tx
					.delete(drafts)
					.where(eq(drafts.id, draft.id))
					.returning({ id: drafts.id });
				// The draft vanished under us (published concurrently).
				if (deleted.length === 0) return { kind: 'not-found' as const };
				// Revert references to the published body; a placeholder row is
				// deleted right below, so its references must go with it (Q15
				// deletion hooks: pages hard-delete + placeholder delete).
				const placeholder = Boolean(post && post.version === 0 && post.status === 'draft');
				// The restore-sync heals legacy interim rows written under the
				// target identity before 3b2; the full clear then removes this
				// draft's own refs (a draft-only image flips detached inside it).
				await syncFileReferences(
					tx,
					{ type: 'post', id: draft.refId },
					placeholder ? [] : keysFromContent(post?.content)
				);
				await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
				let removedPlaceholder = false;
				// A never-published placeholder goes with its draft (§9.14.3).
				if (post && placeholder) {
					await tx.delete(posts).where(eq(posts.id, post.id));
					removedPlaceholder = true;
				}
				return { kind: 'discarded' as const, postId: draft.refId, removedPlaceholder };
			}

			const deleted = await tx
				.delete(drafts)
				.where(eq(drafts.id, draft.id))
				.returning({ id: drafts.id });
			if (deleted.length === 0) return { kind: 'not-found' as const };
			await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
			return { kind: 'discarded' as const, postId: null, removedPlaceholder: false };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

/* ── Create translation (§9.20.4) ────────────────────────────────────── */

export type CreateTranslationResult =
	| { kind: 'created'; postId: string }
	| { kind: 'not-found' }
	| { kind: 'same-lang' }
	| { kind: 'lang-exists' }
	/** R7 禁链式: only a group source can spawn a translation. */
	| { kind: 'not-source' };

export async function createTranslationDraft(
	sourceId: string,
	lang: string,
	author?: string | null
): Promise<CreateTranslationResult> {
	const [source] = await db.select().from(posts).where(eq(posts.id, sourceId)).limit(1);
	if (!source) return { kind: 'not-found' };
	if (source.lang === lang) return { kind: 'same-lang' };
	// R7 (ledger §14.4): translations always point at the group source; the
	// partial unique index cannot see this, it is an application-level rule.
	if (source.translatedFromPostId) return { kind: 'not-source' };

	const [sibling] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(and(eq(posts.translationGroup, source.translationGroup), eq(posts.lang, lang)))
		.limit(1);
	if (sibling) return { kind: 'lang-exists' };

	try {
		return await db.transaction(async (tx) => {
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

			const [translationDraft] = await tx
				.insert(drafts)
				.values({
					refType: 'post',
					refId: created.id,
					title: source.title,
					slug: null,
					categoryId: source.categoryId,
					tags: [],
					content: source.content == null ? null : canonicalLf(source.content),
					contentFormat: source.contentFormat ?? 'markdown',
					summary: source.summary,
					version: 1,
					baseVersion: 0,
					author: author ?? null,
					updatedAt: new Date()
				})
				.returning({ id: drafts.id });
			// The copied body's keys become this draft's own refs (3b2): a
			// later source edit must not orphan an image the draft carries.
			await syncFileReferences(
				tx,
				{ type: 'draft', id: translationDraft.id },
				keysFromContent(source.content)
			);

			return { kind: 'created' as const, postId: created.id };
		});
	} catch (caught) {
		// Concurrent duplicate: (translation_group, lang) is the arbiter. A temp
		// slug collision would be mislabelled, but its odds are negligible and
		// the retry is harmless (the user sees "该语言版本已存在").
		if (pgErrorCode(caught) === '23505') return { kind: 'lang-exists' };
		throw caught;
	}
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

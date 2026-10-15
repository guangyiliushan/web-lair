import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { drafts, pages } from '$lib/server/db/content';
import type {
	LocalizedMarkdown,
	LocalizedText,
	PageDraftPayload,
	PageLocale
} from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { keysFromLocalizedContent, syncFileReferences } from './file-references';
import { isReservedPageSlug } from '$lib/utils/page-meta';
import { DRAFT_THROTTLE_MS } from './post-drafts';
import { m } from '$lib/paraglide/messages';

/**
 * Draft-flow service for md pages (pages line P5-1; ledger §19.10, plan v0.8
 * §7): mirrors `note-drafts` - one `drafts` row per target, autosave with
 * hash / throttle / optimistic lock, and the publish transaction copies the
 * working copy onto `pages` and drops the draft. The five deliberate
 * differences from the notes mirror (W1 ruling, 2026-10-14):
 *
 *   1. payload: the three-locale editing surface ({title, description,
 *      content}) travels in the `drafts.payload` jsonb column (P5-0); the
 *      slug keeps the shared `drafts.slug` column, and the row-level
 *      `title`/`content` columns stay off the write set.
 *   2. the placeholder row is the `pages` row itself (slug `draft-…`,
 *      `status` hidden, content null = "never published").
 *   3. publish status is CONDITIONAL (W1): the first publish of a placeholder
 *      flips `visible`; re-publishing an existing row keeps its status.
 *   4. NO slug tracker on rename: `slug_trackers` whitelists
 *      post|tag|note|photo, and pages answer the old URL with 404 by design
 *      (P3-a). The default rows (`about` / `about-site`) are slug-locked
 *      instead - their slugs are seed anchors.
 *   5. reference diffs run over `keysFromLocalizedContent` (union of every
 *      locale's markdown), the draft identity carries them until publish.
 *
 * Pages have no publishedAt / status history: "never published" is read from
 * `content is null` only, and there are no note-style row-level settings
 * (pin / password / …) to keep outside the draft.
 */
/** Marker for the auto-generated slug of never-published placeholder rows. */
const PLACEHOLDER_SLUG_PREFIX = 'draft-';

export function isPagePlaceholderSlug(slug: string): boolean {
	return slug.startsWith(PLACEHOLDER_SLUG_PREFIX);
}

/**
 * Rows the draft editor owns (B1/R2-5 review): md rows plus their
 * never-published placeholder form. THE single predicate source - the edit
 * route's load and `?/save`, this service's attach / publish guards all
 * consume it, so no consumer can drift. (The admin list only needs
 * `isPagePlaceholderSlug` for its delete-dialog copy; nothing else should
 * grow a parallel predicate.)
 */
export function isPageEditorRow(row: { content: unknown; slug: string }): boolean {
	return row.content !== null || isPagePlaceholderSlug(row.slug);
}

/** Unique-enough placeholder slug; the real slug is required at publish. */
function pageTempSlug(): string {
	return `${PLACEHOLDER_SLUG_PREFIX}${randomBytes(5).toString('hex')}`;
}

/** The three editable locales in canonical order - the payload key order is
 * part of the hash basis, so the order is fixed here, not at the caller. */
const PAGE_LOCALES: readonly PageLocale[] = ['en', 'zh-cn', 'ja'];

interface NormalizedPageDraft {
	slug: string;
	title: LocalizedText;
	description: LocalizedText;
	content: LocalizedMarkdown;
}

/** LF (and lone CR) to LF - the one canonicalization point for page drafts. */
function canonicalLf(value: string): string {
	return value.replace(/\r\n?/g, '\n');
}

/**
 * Keep only the three known locales and drop empty strings (markdown bodies
 * are additionally LF-canonicalized): jsonb round-trips preserve key order,
 * so the stored payload and the hash basis share this exact shape and a
 * dropped locale can never fake a change.
 */
function localeMap(
	value: LocalizedText | LocalizedMarkdown | null | undefined,
	markdown: boolean
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const locale of PAGE_LOCALES) {
		const raw = value?.[locale];
		if (typeof raw !== 'string') continue;
		const normalized = markdown ? canonicalLf(raw) : raw;
		if (normalized === '') continue;
		out[locale] = normalized;
	}
	return out;
}

function normalizePageDraft(
	slug: string | null | undefined,
	payload: Partial<PageDraftPayload> | null | undefined
): NormalizedPageDraft {
	return {
		slug: (slug ?? '').trim(),
		title: localeMap(payload?.title, false),
		description: localeMap(payload?.description, false),
		content: localeMap(payload?.content, true)
	};
}

/**
 * The exact write set (single source of truth): any change that
 * `pageDraftUpdateSet` persists is part of the hash by construction, so a
 * new editable field can never silently skip the "unchanged" fast path.
 * Empty maps fold to null - '' and absent are the same edit.
 */
function pageDraftUpdateSet(value: NormalizedPageDraft) {
	return {
		slug: value.slug === '' ? null : value.slug,
		payload: {
			title: value.title,
			description: Object.keys(value.description).length === 0 ? null : value.description,
			content: value.content
		}
	};
}

/** The "hash 不变不写" comparison basis (§9.10) - payload + slug vs stored
 * row. The slug rides the shared drafts column, hence the explicit argument. */
export function pageDraftHash(slug: string | null | undefined, payload: PageDraftPayload): string {
	return hashNormalized(normalizePageDraft(slug, payload));
}

function hashNormalized(value: NormalizedPageDraft): string {
	return createHash('sha256')
		.update(JSON.stringify(pageDraftUpdateSet(value)))
		.digest('hex');
}

type PageDraftRow = typeof drafts.$inferSelect;

function hashRow(row: PageDraftRow): string {
	return hashNormalized(normalizePageDraft(row.slug, row.payload));
}

async function loadPageDraftById(draftId: string): Promise<PageDraftRow | null> {
	const [row] = await db
		.select()
		.from(drafts)
		.where(and(eq(drafts.id, draftId), eq(drafts.refType, 'page')))
		.limit(1);
	return row ?? null;
}

export async function loadPageDraftByPageId(pageId: string): Promise<PageDraftRow | null> {
	const [row] = await db
		.select()
		.from(drafts)
		.where(and(eq(drafts.refType, 'page'), eq(drafts.refId, pageId)))
		.limit(1);
	return row ?? null;
}

/** Publish-side "at least one locale is non-blank" gate over a locale map. */
function hasNonBlankLocale(value: Record<string, string>): boolean {
	return Object.values(value).some((entry) => entry.trim() !== '');
}

/* ── Save (autosave + manual share one path) ─────────────────────────── */

export type SavePageDraftResult =
	| { kind: 'saved'; draftId: string; version: number; pageId: string; updatedAt: Date | null }
	| { kind: 'unchanged'; draftId: string; version: number; pageId: string }
	| { kind: 'throttled'; draftId: string; version: number; pageId: string; retryAfterMs: number }
	| {
			kind: 'conflict';
			server: { draftId: string | null; version: number; updatedAt: Date | null };
	  }
	| { kind: 'not-found' };

export interface SavePageDraftInput {
	/** Draft row address (preferred once the client has one). */
	draftId?: string | null;
	/** Pages id (existing md page, or absent for a brand-new page). */
	pageId?: string | null;
	/** Draft version the client last saw (optimistic lock, §9.10). */
	expectedVersion?: number | null;
	/** Candidate slug - the shared drafts.slug column (W1: slug stays off
	 * the payload). */
	slug?: string | null;
	payload: PageDraftPayload;
	author?: string | null;
	/** Autosave skips the 30s server throttle; manual saves always go through. */
	autosave: boolean;
}

export async function savePageDraftWork(input: SavePageDraftInput): Promise<SavePageDraftResult> {
	const normalized = normalizePageDraft(input.slug, input.payload);

	// Address by draft row first (covers both new placeholders and edits).
	if (input.draftId) {
		const draft = await loadPageDraftById(input.draftId);
		if (!draft) {
			// The row is gone: it was published or discarded elsewhere.
			return { kind: 'conflict', server: { draftId: null, version: 0, updatedAt: null } };
		}
		return updateExistingPageDraft(draft, normalized, input);
	}

	if (input.pageId) {
		const existing = await loadPageDraftByPageId(input.pageId);
		if (existing) return updateExistingPageDraft(existing, normalized, input);

		const targetPageId = input.pageId;
		try {
			// Attaching the first draft is a save path too: the content write
			// and the reference diff share one transaction (Q15), the
			// submitted locales being the desired set. The page row is locked
			// FIRST (the pages → drafts → files order every writer follows)
			// so a concurrent hard-delete cannot slip its cascade between the
			// row check and the insert (R2-2 review).
			const created = await db.transaction(async (tx) => {
				const [page] = await tx
					.select({ id: pages.id, content: pages.content, slug: pages.slug })
					.from(pages)
					.where(eq(pages.id, targetPageId))
					.limit(1)
					.for('update');
				if (!page) return null;
				// Only editor rows accept drafts (M3 review): blindly
				// attaching to a code / external row would let the publish
				// transaction flip it into an md page with no editor path
				// ever having shown that face.
				if (!isPageEditorRow(page)) return null;
				const [row] = await tx
					.insert(drafts)
					.values({
						refType: 'page',
						refId: page.id,
						...pageDraftUpdateSet(normalized),
						version: 1,
						// Pages have no row version counter: the draft's own
						// optimistic version plus the one-draft-per-page unique
						// cover every documented conflict scenario (N1 decision,
						// carried over from notes).
						baseVersion: null,
						author: input.author ?? null,
						updatedAt: new Date()
					})
					.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
				// Draft-phase references key on the DRAFT's own identity
				// (3b2): the published row's ref set keeps describing the
				// published body until a publish re-keys it (Q6/Q15).
				await syncFileReferences(
					tx,
					{ type: 'draft', id: row.id },
					keysFromLocalizedContent(normalized.content)
				);
				return { ...row, pageId: page.id };
			});
			if (created === null) return { kind: 'not-found' };
			return {
				kind: 'saved',
				draftId: created.id,
				version: created.version,
				pageId: created.pageId,
				updatedAt: created.updatedAt
			};
		} catch (caught) {
			// A concurrent tab created the draft first - surface it as a conflict.
			if (pgErrorCode(caught) === '23505') {
				const server = await loadPageDraftByPageId(input.pageId);
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

	// Brand-new page: NO precondition - the first save materializes the
	// placeholder pages row (§9.10 auto-draft style, mirroring notes; the
	// rows stay hidden until a publish flips them).
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const result = await db.transaction(async (tx) => {
				const [createdPage] = await tx
					.insert(pages)
					.values({
						// jsonb NOT NULL: seed with the submitted map; publish
						// rewrites it from the locked draft anyway. content
						// stays null - the "never published" marker the
						// discard path reads; content_format has no default.
						title: normalized.title,
						slug: pageTempSlug(),
						status: 'hidden',
						contentFormat: 'markdown'
					})
					.returning({ id: pages.id });
				const [createdDraft] = await tx
					.insert(drafts)
					.values({
						refType: 'page',
						refId: createdPage.id,
						...pageDraftUpdateSet(normalized),
						version: 1,
						baseVersion: null,
						author: input.author ?? null,
						updatedAt: new Date()
					})
					.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
				// References ride the materialization transaction (Q15) under
				// the DRAFT identity (3b2).
				await syncFileReferences(
					tx,
					{ type: 'draft', id: createdDraft.id },
					keysFromLocalizedContent(normalized.content)
				);
				return { pageId: createdPage.id, draft: createdDraft };
			});
			return {
				kind: 'saved',
				draftId: result.draft.id,
				version: result.draft.version,
				pageId: result.pageId,
				updatedAt: result.draft.updatedAt
			};
		} catch (caught) {
			// Placeholder slug collision (extremely unlikely): retry with a new one.
			if (pgErrorCode(caught) === '23505' && attempt < 2) continue;
			throw caught;
		}
	}
	throw new Error('page draft placeholder creation failed');
}

async function updateExistingPageDraft(
	draft: PageDraftRow,
	normalized: NormalizedPageDraft,
	input: SavePageDraftInput
): Promise<SavePageDraftResult> {
	const pageId = draft.refId ?? '';

	// "hash 不变不写" - identical payloads never bump the version.
	if (hashRow(draft) === hashNormalized(normalized)) {
		return { kind: 'unchanged', draftId: draft.id, version: draft.version, pageId };
	}

	// Autosave throttle: at most one write per draft per 30s (§9.10). Manual
	// saves bypass it; the client retries from the `retryAfterMs` hint.
	const lastWrite = draft.updatedAt?.getTime() ?? 0;
	const elapsed = Date.now() - lastWrite;
	if (input.autosave && elapsed < DRAFT_THROTTLE_MS) {
		return {
			kind: 'throttled',
			draftId: draft.id,
			version: draft.version,
			pageId,
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

	// The target row must still exist before a write may claim success (M1
	// review): the list delete cascades drafts, so a surviving draft with a
	// missing page is a legacy orphan - answer not-found instead of the
	// false `saved` the old path returned. Sits AFTER the hash/version gates
	// so no-op autosaves never pay the lookup.
	if (pageId !== '') {
		const [target] = await db
			.select({ id: pages.id })
			.from(pages)
			.where(eq(pages.id, pageId))
			.limit(1);
		if (!target) return { kind: 'not-found' };
	}

	const expected = input.expectedVersion ?? draft.version;
	// Content write + reference diff share one transaction (Q15); the hash
	// gate above keeps no-op autosaves from re-scanning (Q6). Page updates
	// carry no FK fields of their own, so only the conditional-update miss
	// needs handling below.
	const updated = await db.transaction(async (tx) => {
		const rows = await tx
			.update(drafts)
			.set({
				...pageDraftUpdateSet(normalized),
				version: draft.version + 1,
				updatedAt: new Date()
			})
			.where(and(eq(drafts.id, draft.id), eq(drafts.version, expected)))
			.returning({ id: drafts.id, version: drafts.version, updatedAt: drafts.updatedAt });
		if (rows.length > 0) {
			// Draft identity (3b2): the working copy's refs never touch the
			// published page's ref set.
			await syncFileReferences(
				tx,
				{ type: 'draft', id: draft.id },
				keysFromLocalizedContent(normalized.content)
			);
		}
		return rows;
	});

	if (updated.length === 0) {
		// Lost the conditional update to a concurrent save.
		const server = await loadPageDraftById(draft.id);
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
		pageId,
		updatedAt: updated[0].updatedAt
	};
}

/* ── Publish transaction (§19.10 analogue of §9.10) ──────────────────── */

export type PublishPageResult =
	| { kind: 'published'; pageId: string }
	| { kind: 'not-found' }
	| { kind: 'invalid'; errors: Record<string, string> }
	| { kind: 'slug-taken' }
	| { kind: 'busy' };

/** Pages slugs: lowercase ASCII, digits and single hyphens (P2 route rule;
 * the regex itself rejects the dots in robots.txt / sitemap.xml shapes). */
const PAGE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function publishPageDraft(draftId: string): Promise<PublishPageResult> {
	const draft = await loadPageDraftById(draftId);
	if (!draft || !draft.refId) return { kind: 'not-found' };

	const [page] = await db.select().from(pages).where(eq(pages.id, draft.refId)).limit(1);
	if (!page) return { kind: 'not-found' };
	// Publishing is what actually flips a row's face: refuse rows the editor
	// never owned (R2-4 review) - a legacy / hand-written draft must not turn
	// a code / external row into an md page.
	if (!isPageEditorRow(page)) return { kind: 'not-found' };

	const errors: Record<string, string> = {};
	const normalized = normalizePageDraft(draft.slug, draft.payload);
	const slug = normalized.slug;
	if (!hasNonBlankLocale(normalized.title)) errors.title = m.admin_pages_err_title_required();
	if (!slug) errors.slug = m.admin_pages_err_slug_required();
	else if (!PAGE_SLUG_RE.test(slug)) errors.slug = m.admin_pages_err_bad_slug();
	// Slug-change gates, in the P2 editor's order: a default row refuses any
	// change outright (seed anchors); reserved words cannot be newly taken -
	// a row keeping its own slug is exempt by equality (page-meta contract).
	else if (page.isDefault && slug !== page.slug) errors.slug = m.admin_pages_err_slug_locked();
	else if (isReservedPageSlug(slug) && slug !== page.slug)
		errors.slug = m.admin_pages_err_slug_reserved();
	else if (isPagePlaceholderSlug(slug)) errors.slug = m.admin_editor_err_slug_reserved_prefix();
	if (!hasNonBlankLocale(normalized.content))
		errors.content = m.admin_editor_err_content_required();
	if (Object.keys(errors).length > 0) return { kind: 'invalid', errors };

	try {
		return await db.transaction(async (tx) => {
			// Lock order pages → drafts (same order as discardPageDraft) so a
			// publish and a discard on the same target cannot deadlock, and
			// publish the LOCKED draft: a concurrent save landing between the
			// snapshot and this transaction must not be silently lost.
			const [locked] = await tx
				.select()
				.from(pages)
				.where(eq(pages.id, page.id))
				.limit(1)
				.for('update');
			if (!locked) return { kind: 'not-found' as const };
			// Belt to the snapshot guard above (R2-4 / 三审 F2): the locked
			// row is the authoritative face check.
			if (!isPageEditorRow(locked)) return { kind: 'not-found' as const };

			const [lockedDraft] = await tx
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, draft.id), eq(drafts.refType, 'page')))
				.limit(1)
				.for('update');
			if (!lockedDraft) return { kind: 'not-found' as const };

			const final = normalizePageDraft(lockedDraft.slug, lockedDraft.payload);
			const finalSlug = final.slug;
			if (!hasNonBlankLocale(final.title) || !finalSlug || !hasNonBlankLocale(final.content)) {
				return {
					kind: 'invalid' as const,
					errors: { form: m.admin_editor_err_stale_draft() } as Record<string, string>
				};
			}
			if (
				!PAGE_SLUG_RE.test(finalSlug) ||
				(isReservedPageSlug(finalSlug) && finalSlug !== locked.slug) ||
				isPagePlaceholderSlug(finalSlug) ||
				(locked.isDefault && finalSlug !== locked.slug)
			) {
				return {
					kind: 'invalid' as const,
					errors: { slug: m.admin_editor_err_slug_invalid() } as Record<string, string>
				};
			}

			// Never-renaming rename policy: the draft- slug prefix only ever
			// lives on a never-published placeholder (a publish rewrites the
			// slug, and placeholder-prefixed finals are rejected above), so
			// it doubles as the first-publish marker for the status flip.
			const firstPublish = isPagePlaceholderSlug(locked.slug);
			// No slug_trackers insert on rename (W1 divergence 4): the table
			// whitelists post|tag|note|photo and pages 404 the old slug by
			// design (P3-a); the default rows cannot reach here with a
			// changed slug - slug-locked above.
			await tx
				.update(pages)
				.set({
					slug: finalSlug,
					title: final.title,
					description: Object.keys(final.description).length === 0 ? null : final.description,
					content: final.content,
					contentFormat: lockedDraft.contentFormat,
					updatedAt: new Date(),
					// W1 divergence 3: first publish flips visible, anything
					// already public (or deliberately hidden) keeps its status.
					...(firstPublish ? { status: 'visible' } : {})
				})
				.where(eq(pages.id, locked.id));

			await tx.delete(drafts).where(eq(drafts.id, lockedDraft.id));

			// The published body's key set is the durable reference set
			// (Q15: same transaction as the content write).
			await syncFileReferences(
				tx,
				{ type: 'page', id: locked.id },
				keysFromLocalizedContent(final.content)
			);
			// The draft's own refs leave with the draft row (3b2: full clear).
			await syncFileReferences(tx, { type: 'draft', id: lockedDraft.id }, []);

			return { kind: 'published' as const, pageId: locked.id };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		// pages_slug_uniq: someone else took the slug between check and write.
		if (code === '23505') return { kind: 'slug-taken' };
		// Deadlock/serialization failures are retryable admin-action conflicts.
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

/* ── Discard (§9.14.3 analogue) ──────────────────────────────────────── */

export type DiscardPageResult =
	| { kind: 'discarded'; pageId: string | null; removedPlaceholder: boolean }
	| { kind: 'not-found' }
	| { kind: 'busy' };

export async function discardPageDraft(draftId: string): Promise<DiscardPageResult> {
	try {
		return await db.transaction(async (tx) => {
			const [draft] = await tx
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, draftId), eq(drafts.refType, 'page')))
				.limit(1);
			if (!draft) return { kind: 'not-found' as const };

			if (draft.refId) {
				// Lock order matches publishPageDraft (pages → drafts).
				const [page] = await tx
					.select({
						id: pages.id,
						slug: pages.slug,
						content: pages.content,
						isDefault: pages.isDefault
					})
					.from(pages)
					.where(eq(pages.id, draft.refId))
					.limit(1)
					.for('update');
				const deleted = await tx
					.delete(drafts)
					.where(eq(drafts.id, draft.id))
					.returning({ id: drafts.id });
				// The draft vanished under us (published concurrently).
				if (deleted.length === 0) return { kind: 'not-found' as const };
				// A never-published placeholder goes with its draft (W1:
				// content null is the ruling's marker; the draft- slug adds
				// the "created by the 新增 flow" belt - a publish rewrites
				// the slug, so a published row never carries it, and any
				// mismatch keeps the row on the safe side). NOTE: this is
				// NOT !isPageEditorRow - that negation is the code row; the
				// removal gate needs content null AND the prefix together.
				const placeholder = Boolean(
					page && !page.isDefault && page.content == null && isPagePlaceholderSlug(page.slug)
				);
				// Revert references to the published body; a placeholder row
				// is deleted right below, so its references must go with it
				// (Q15 deletion hooks). The restore-sync also heals legacy
				// interim rows written under the target identity before 3b2.
				await syncFileReferences(
					tx,
					{ type: 'page', id: draft.refId },
					placeholder ? [] : keysFromLocalizedContent(page?.content)
				);
				await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
				let removedPlaceholder = false;
				if (page && placeholder) {
					await tx.delete(pages).where(eq(pages.id, page.id));
					removedPlaceholder = true;
				}
				return { kind: 'discarded' as const, pageId: draft.refId, removedPlaceholder };
			}

			const deleted = await tx
				.delete(drafts)
				.where(eq(drafts.id, draft.id))
				.returning({ id: drafts.id });
			if (deleted.length === 0) return { kind: 'not-found' as const };
			await syncFileReferences(tx, { type: 'draft', id: draft.id }, []);
			return { kind: 'discarded' as const, pageId: null, removedPlaceholder: false };
		});
	} catch (caught) {
		const code = pgErrorCode(caught);
		if (code === '40P01' || code === '40001') return { kind: 'busy' };
		throw caught;
	}
}

/* ── Read helpers for the lists ──────────────────────────────────────── */

/** Pages that already have a pending (unpublished) draft - list badge. */
export async function draftsForPages(pageIds: string[]): Promise<Set<string>> {
	if (pageIds.length === 0) return new Set();
	const rows = await db
		.select({ refId: drafts.refId })
		.from(drafts)
		.where(and(eq(drafts.refType, 'page'), inArray(drafts.refId, pageIds)));
	return new Set(rows.map((r) => r.refId).filter((id): id is string => id != null));
}

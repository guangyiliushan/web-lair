import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { pages, type LocalizedText } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption } from '$lib/server/config/options-registry';
import { pgErrorCode } from '$lib/server/db/pg-error';
import {
	discardPageDraft,
	isPageEditorRow,
	isPagePlaceholderSlug,
	loadPageDraftByPageId,
	publishPageDraft,
	savePageDraftWork
} from '$lib/server/services/page-drafts';
import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
import { isReservedPageSlug } from '$lib/utils/page-meta';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALES = ['en', 'zh-cn', 'ja'] as const;

// The editor-ownership predicate lives in the service (isPageEditorRow):
// THE single source (R2-5 review) shared by this route's load / `?/save`,
// the service's attach / publish guards and the admin list.

/**
 * Pages editor. Two shapes share the route (P5-2 single-source rule):
 *
 * - md rows (`content` not null): the md editor is the SINGLE SOURCE - the
 *   title / description / content / slug editing surface lives in one
 *   `drafts.payload` (ledger §19.10) and only the publish transaction writes
 *   the row. `?/save` is narrowed there to the row properties (icon /
 *   external_url), which are never staged in drafts.
 * - code / external rows (`content` null): the P2 metadata form, unchanged.
 *
 * Draft actions mirror the notes editor (`?/saveDraft` / `?/publish` /
 * `?/discard`); conflicts answer 409 so the client refuses to overwrite.
 */
export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	// ?id= loads an existing row; WITHOUT it the page is new (P5-3): the
	// editor materializes the placeholder row on the first draft save
	// (auto-draft, mirroring the notes editor).
	const id = url.searchParams.get('id');
	if (id && !isUuid(id)) error(404, m.admin_pages_err_not_found());

	const defaultLangOption = await getOption('site.default_lang');
	const defaultLang = (LOCALES as readonly string[]).includes(defaultLangOption)
		? defaultLangOption
		: LOCALES[0];

	let row: typeof pages.$inferSelect | null = null;
	let draftRow: Awaited<ReturnType<typeof loadPageDraftByPageId>> = null;
	if (id) {
		[row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
		if (!row) error(404, m.admin_pages_err_not_found());
		// Only editor rows hand out a draft (R2-4 review): the P2 form never
		// publishes, so a legacy / hand-written draft on a code / external
		// row must not resurface here at all.
		if (isPageEditorRow(row)) draftRow = await loadPageDraftByPageId(row.id);
	}

	return {
		headerTitle: m.admin_pages_edit_title(),
		headerActions: [
			{
				label: m.admin_common_back(),
				iconName: 'arrow-left',
				variant: 'outline',
				href: '/admin/pages'
			}
		],
		defaultLang,
		page: row
			? {
					id: row.id,
					slug: row.slug,
					title: row.title,
					description: row.description ?? {},
					icon: row.icon ?? '',
					externalUrl: row.externalUrl ?? '',
					isDefault: row.isDefault,
					status: row.status,
					placeholder: isPagePlaceholderSlug(row.slug),
					newPage: false,
					editorMode: isPageEditorRow(row),
					updatedAt: row.updatedAt
				}
			: {
					// New-mode virtual target (P5-3): the editor runs on an
					// empty payload; the first draft save materializes the row.
					id: '',
					slug: '',
					title: {} as LocalizedText,
					description: {} as LocalizedText,
					icon: '',
					externalUrl: '',
					isDefault: false,
					status: 'hidden',
					placeholder: true,
					newPage: true,
					editorMode: true,
					updatedAt: null
				},
		draft: draftRow
			? {
					id: draftRow.id,
					version: draftRow.version,
					slug: draftRow.slug,
					title: draftRow.payload?.title ?? {},
					description: draftRow.payload?.description ?? {},
					content: draftRow.payload?.content ?? {},
					updatedAt: draftRow.updatedAt
				}
			: null
	};
};

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

function localizedFrom(form: FormData, prefix: string, trim = true): LocalizedText {
	const result: LocalizedText = {};
	for (const locale of LOCALES) {
		const raw = str(form, `${prefix}_${locale}`);
		const value = trim ? raw.trim() : raw;
		if (value !== '') result[locale] = value;
	}
	return result;
}

export const actions: Actions = {
	/**
	 * Row-properties direct save. For md rows (content !== null) this writes
	 * ONLY the row-level properties (icon / external_url): title /
	 * description / content / slug are draft-owned there (single source) and
	 * travel through the draft actions below. Code / external rows keep the
	 * full P2 metadata write.
	 */
	save: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_pages_err_missing_id() });
		const pageId = id.toLowerCase();

		const [row] = await db
			.select({
				id: pages.id,
				slug: pages.slug,
				isDefault: pages.isDefault,
				content: pages.content
			})
			.from(pages)
			.where(eq(pages.id, pageId))
			.limit(1);
		if (!row) return fail(404, { error: m.admin_pages_err_not_found() });

		const icon = str(form, 'icon').trim();
		if (icon !== '' && !(NAV_ICON_NAMES as readonly string[]).includes(icon)) {
			return fail(400, { error: m.admin_pages_err_icon_whitelist() });
		}
		const externalUrl = str(form, 'externalUrl').trim();
		if (externalUrl !== '' && !/^https?:\/\//.test(externalUrl)) {
			return fail(400, { error: m.admin_pages_err_bad_external() });
		}

		if (isPageEditorRow(row)) {
			// md row (incl. its never-published placeholder form): properties
			// only - the editor owns everything else (R2-5: same predicate as
			// the load projection's `editorMode`).
			const updated = await db
				.update(pages)
				.set({
					icon: icon === '' ? null : icon,
					externalUrl: externalUrl === '' ? null : externalUrl
				})
				.where(eq(pages.id, pageId))
				.returning({ id: pages.id });
			if (updated.length === 0) return fail(404, { error: m.admin_pages_err_not_found() });
			return { success: true };
		}

		const title = localizedFrom(form, 'title');
		if (Object.keys(title).length === 0)
			return fail(400, { error: m.admin_pages_err_title_required() });

		const description = localizedFrom(form, 'description');

		const slug = str(form, 'slug').trim().toLowerCase();
		if (!slug) return fail(400, { error: m.admin_pages_err_slug_required() });
		if (!SLUG_RE.test(slug)) return fail(400, { error: m.admin_pages_err_bad_slug() });
		if (slug !== row.slug) {
			if (row.isDefault) return fail(400, { error: m.admin_pages_err_slug_locked() });
			if (isReservedPageSlug(slug)) return fail(400, { error: m.admin_pages_err_slug_reserved() });
			// The draft- prefix means "the draft editor owns this row" since
			// B1 (R2-1 review): letting the metadata form mint one would flip
			// a code / external row into the editor while its external_url
			// stays set - published content the site then 404s forever.
			if (isPagePlaceholderSlug(slug))
				return fail(400, { error: m.admin_editor_err_slug_reserved_prefix() });
		}

		let updated: { id: string }[];
		try {
			updated = await db
				.update(pages)
				.set({
					title,
					description: Object.keys(description).length > 0 ? description : null,
					icon: icon === '' ? null : icon,
					externalUrl: externalUrl === '' ? null : externalUrl,
					slug
				})
				.where(eq(pages.id, pageId))
				.returning({ id: pages.id });
		} catch (caught) {
			// Only a unique violation is a user-visible conflict (topics pattern).
			if (pgErrorCode(caught) !== '23505') throw caught;
			return fail(409, { error: m.admin_pages_err_slug_taken() });
		}
		if (updated.length === 0) return fail(404, { error: m.admin_pages_err_not_found() });
		return { success: true };
	},

	/**
	 * Draft autosave (`autosave=1`) and the manual "Save draft" share this
	 * action; conflicts answer 409 so the client refuses to overwrite. The
	 * three-locale maps travel as `title_<locale>` / `description_<locale>` /
	 * `content_<locale>` fields; the slug rides its own field.
	 */
	saveDraft: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const rawId = str(form, 'id').trim();
		const draftId = str(form, 'draftId').trim();
		const versionRaw = str(form, 'draftVersion').trim();
		const autosave = form.get('autosave') === '1';
		// Malformed ids must never reach a uuid column (22P02 → 500).
		if (rawId && !isUuid(rawId)) return fail(400, { message: m.admin_pages_err_missing_id() });
		if (draftId && !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });

		const result = await savePageDraftWork({
			draftId: draftId || null,
			pageId: rawId || null,
			// A non-numeric version is treated as "not provided" (mirrors the
			// notes editor's permanent-409 review finding).
			expectedVersion: /^\d+$/.test(versionRaw) ? Number(versionRaw) : null,
			slug: str(form, 'slug').trim().toLowerCase(),
			payload: {
				title: localizedFrom(form, 'title'),
				description: localizedFrom(form, 'description'),
				// Markdown bodies are NOT trimmed: leading indentation is
				// meaningful in code blocks (LF canonicalisation lives in the
				// service).
				content: localizedFrom(form, 'content', false)
			},
			author: locals.admin?.userId ?? locals.user?.id ?? null,
			autosave
		});

		switch (result.kind) {
			case 'saved':
				return {
					saved: true,
					draftId: result.draftId,
					draftVersion: result.version,
					pageId: result.pageId || null,
					updatedAt: result.updatedAt
				};
			case 'unchanged':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					pageId: result.pageId || null
				};
			case 'throttled':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					pageId: result.pageId || null,
					retryAfterMs: result.retryAfterMs
				};
			case 'not-found':
				return fail(404, { message: m.admin_pages_err_not_found() });
			case 'conflict':
				return fail(409, {
					conflict: true,
					server: result.server,
					message: m.admin_posts_edit_err_conflict_long()
				});
		}
	},

	/** Publish transaction: copy the locked draft onto the pages row. */
	publish: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });

		const result = await publishPageDraft(draftId);
		switch (result.kind) {
			case 'published':
				throw redirect(303, `/admin/pages/edit?id=${result.pageId}&published=1`);
			case 'invalid':
				return fail(400, {
					errors: result.errors,
					message: m.admin_posts_edit_err_publish_validation()
				});
			case 'slug-taken':
				// Field-level 400, unlike the metadata form's 409: the editor
				// shows it inline next to the slug input (T9 review - the
				// difference is deliberate, do not "align" it away).
				return fail(400, { errors: { slug: m.admin_pages_err_slug_taken() } });
			case 'busy':
				return fail(409, { message: m.admin_posts_edit_err_busy() });
			case 'not-found':
				return fail(404, { message: m.admin_posts_edit_err_draft_not_found() });
		}
	},

	/** Explicit discard: a never-published page goes with its draft. */
	discard: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId))
			return fail(400, { message: m.admin_posts_edit_err_bad_draft_id() });

		const result = await discardPageDraft(draftId);
		if (result.kind === 'not-found')
			return fail(404, { message: m.admin_posts_edit_err_draft_not_found() });
		if (result.kind === 'busy') return fail(409, { message: m.admin_posts_edit_err_busy() });
		if (result.removedPlaceholder) throw redirect(303, '/admin/pages?discarded=1');
		if (result.pageId) throw redirect(303, `/admin/pages/edit?id=${result.pageId}&discarded=1`);
		throw redirect(303, '/admin/pages?discarded=1');
	}
};

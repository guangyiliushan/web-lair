import { fail } from '@sveltejs/kit';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { getLocale } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import { pages } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { resolveLocalized } from '$lib/server/services/pages';
import { isPagePlaceholderSlug } from '$lib/server/services/page-drafts';
import { syncFileReferences } from '$lib/server/services/file-references';
import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
import { isReservedPageSlug } from '$lib/utils/page-meta';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCALES = ['en', 'zh-cn', 'ja'] as const;

/**
 * Pages admin v1 (P2, plan §4): the registry list with ▲/▼ reordering,
 * visible/hidden toggling and confirmed deletion. 「New」 was withheld for P5
 * and lands here as P5-3: the md type starts in the draft editor
 * (`/admin/pages/edit` without an id - the editor materializes the placeholder
 * row on its first save), the external entry inserts DIRECTLY from the list
 * dialog (`?/create`, no draft - ledger §19.10). `is_default` rows stay
 * protected (no delete) and keep a read-only slug in the editor
 * (db:ensure-pages anchors on the slug).
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();

	const locale = getLocale();
	const rows = await db
		.select({
			id: pages.id,
			slug: pages.slug,
			title: pages.title,
			externalUrl: pages.externalUrl,
			status: pages.status,
			sortOrder: pages.sortOrder,
			isDefault: pages.isDefault,
			hasContent: sql<boolean>`${pages.content} is not null`.mapWith(Boolean),
			updatedAt: pages.updatedAt
		})
		.from(pages)
		.orderBy(desc(pages.isDefault), asc(pages.sortOrder), asc(pages.createdAt));

	return {
		headerTitle: m.admin_nav_pages(),
		pages: rows.map((row) => ({
			...row,
			title: resolveLocalized(row.title, locale) ?? row.slug
		}))
	};
};

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

function localizedFrom(form: FormData, prefix: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const locale of LOCALES) {
		const value = str(form, `${prefix}_${locale}`).trim();
		if (value !== '') result[locale] = value;
	}
	return result;
}

export const actions: Actions = {
	/**
	 * 「新增」外链条目 (P5-3): direct insert, no draft - the row IS the content
	 * registry entry (external_url + optionally a code-route registration on
	 * the site side). The md type never reaches this action: it starts in the
	 * draft editor instead.
	 */
	create: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();

		const title = localizedFrom(form, 'title');
		if (Object.keys(title).length === 0)
			return fail(400, { error: m.admin_pages_err_title_required() });

		const slug = str(form, 'slug').trim().toLowerCase();
		if (!slug) return fail(400, { error: m.admin_pages_err_slug_required() });
		if (!SLUG_RE.test(slug)) return fail(400, { error: m.admin_pages_err_bad_slug() });
		if (isReservedPageSlug(slug)) return fail(400, { error: m.admin_pages_err_slug_reserved() });
		// The draft- prefix is reserved for never-published placeholder rows.
		if (isPagePlaceholderSlug(slug))
			return fail(400, { error: m.admin_editor_err_slug_reserved_prefix() });

		const icon = str(form, 'icon').trim();
		if (icon !== '' && !(NAV_ICON_NAMES as readonly string[]).includes(icon)) {
			return fail(400, { error: m.admin_pages_err_icon_whitelist() });
		}
		// An external entry without its URL would be a dead menu item.
		const externalUrl = str(form, 'externalUrl').trim();
		if (!externalUrl || !/^https?:\/\//.test(externalUrl)) {
			return fail(400, { error: m.admin_pages_err_bad_external() });
		}

		const description = localizedFrom(form, 'description');

		try {
			const [created] = await db
				.insert(pages)
				.values({
					title,
					description: Object.keys(description).length > 0 ? description : null,
					icon: icon === '' ? null : icon,
					externalUrl,
					slug,
					status: 'visible',
					// content stays null: external entries are registry rows
					// (and content_format has no DB default).
					contentFormat: 'markdown'
				})
				.returning({ id: pages.id });
			return { success: true, id: created.id };
		} catch (caught) {
			// Only a unique violation is a user-visible conflict (topics pattern).
			if (pgErrorCode(caught) !== '23505') throw caught;
			return fail(409, { error: m.admin_pages_err_slug_taken() });
		}
	},

	/**
	 * ▲/▼: full-list renumber inside one transaction. The locking read
	 * serializes concurrent moves (P2 review); cross-group targets - the
	 * first extra's ▲ / the last default's ▼ - are a no-op success, since
	 * display order pins defaults first and writing there would only invert
	 * invisible sort values.
	 */
	move: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		const direction = str(form, 'direction');
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_pages_err_missing_id() });
		if (direction !== 'up' && direction !== 'down')
			return fail(400, { error: m.admin_pages_err_bad_direction() });
		const pageId = id.toLowerCase();

		const result = await db.transaction(async (tx) => {
			const ordered = await tx
				.select({ id: pages.id, isDefault: pages.isDefault })
				.from(pages)
				.orderBy(desc(pages.isDefault), asc(pages.sortOrder), asc(pages.createdAt))
				.for('update');
			const index = ordered.findIndex((row) => row.id === pageId);
			if (index < 0) return { kind: 'not-found' as const };
			const target = direction === 'up' ? index - 1 : index + 1;
			if (
				target >= 0 &&
				target < ordered.length &&
				ordered[target].isDefault === ordered[index].isDefault
			) {
				const swapped = [...ordered];
				[swapped[index], swapped[target]] = [swapped[target], swapped[index]];
				for (let position = 0; position < swapped.length; position += 1) {
					// Raw SQL on purpose: the builder would merge the column's
					// `$onUpdate` into SET and bump every row's updated_at,
					// rotating the pages' sitemap lastmod on a pure reorder
					// (sorting is not a content change; P2 review).
					await tx.execute(
						sql`update pages set sort_order = ${position} where id = ${swapped[position].id}`
					);
				}
			}
			return { kind: 'moved' as const };
		});

		if (result.kind === 'not-found') return fail(404, { error: m.admin_pages_err_not_found() });
		return { success: true };
	},

	setStatus: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		const status = str(form, 'status');
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_pages_err_missing_id() });
		if (status !== 'visible' && status !== 'hidden')
			return fail(400, { error: m.admin_pages_err_bad_status() });
		const pageId = id.toLowerCase();

		const updated = await db
			.update(pages)
			.set({ status })
			.where(eq(pages.id, pageId))
			.returning({ id: pages.id });
		if (updated.length === 0) return fail(404, { error: m.admin_pages_err_not_found() });
		return { success: true };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		if (!id || !isUuid(id)) return fail(400, { error: m.admin_pages_err_missing_id() });
		const pageId = id.toLowerCase();

		// Lock + guard + delete share one transaction (topics round-7 pattern).
		const result = await db.transaction(async (tx) => {
			const [row] = await tx
				.select({ id: pages.id, isDefault: pages.isDefault })
				.from(pages)
				.where(eq(pages.id, pageId))
				.limit(1)
				.for('update');
			if (!row) return { kind: 'not-found' as const };
			if (row.isDefault) return { kind: 'protected' as const };
			await tx.delete(pages).where(eq(pages.id, pageId));
			// A hard-deleted page leaves no content behind: clear its
			// references in the same transaction (Q15 deletion hook) so the
			// images it mentioned become detachable again.
			await syncFileReferences(tx, { type: 'page', id: pageId }, []);
			return { kind: 'deleted' as const };
		});

		if (result.kind === 'not-found') return fail(404, { error: m.admin_pages_err_not_found() });
		if (result.kind === 'protected') return fail(409, { error: m.admin_pages_err_protected() });
		return { success: true };
	}
};

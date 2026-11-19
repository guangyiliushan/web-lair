import { error, fail } from '@sveltejs/kit';
import { asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { notes, topics } from '$lib/server/db/content';
import { pgErrorCode } from '$lib/server/db/pg-error';
import { NAV_ICON_NAMES } from '$lib/config/nav-icons';
import { isUuid } from '$lib/utils/uuid';
import { isValidTaxonomySlug, parseTaxonomyI18n } from '$lib/server/services/taxonomy';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

export const load: PageServerLoad = async ({ params }) => {
	await requireAdminRole();
	if (!isUuid(params.id)) error(404, m.admin_notes_topics_err_not_found());

	const [topic] = await db
		.select({
			id: topics.id,
			name: topics.name,
			slug: topics.slug,
			description: topics.description,
			icon: topics.icon,
			sortOrder: topics.sortOrder,
			sourceLang: topics.sourceLang,
			nameI18n: topics.nameI18n,
			descriptionI18n: topics.descriptionI18n
		})
		.from(topics)
		.where(eq(topics.id, params.id));
	if (!topic) error(404, m.admin_notes_topics_err_not_found());

	const related = await db
		.select({
			id: notes.id,
			title: notes.title,
			slug: notes.slug,
			status: notes.status,
			lang: notes.lang,
			updatedAt: notes.updatedAt
		})
		.from(notes)
		.where(eq(notes.topicId, params.id))
		.orderBy(sql`${notes.updatedAt} desc nulls last`, sql`${notes.createdAt} desc`)
		.limit(200);

	// Candidates for "pull in": notes sitting outside this topic — either
	// unfiled (`topic_id` is null) or filed under another topic. Capped; a
	// personal blog's archive is small enough to filter client-side.
	const pickable = await db
		.select({
			id: notes.id,
			title: notes.title,
			status: notes.status,
			lang: notes.lang
		})
		.from(notes)
		.where(or(isNull(notes.topicId), ne(notes.topicId, params.id)))
		.orderBy(sql`${notes.updatedAt} desc nulls last`)
		.limit(200);

	return {
		headerActions: [
			{
				label: m.admin_common_back_to_list(),
				iconName: 'arrow-left',
				variant: 'ghost',
				href: '/admin/notes/topics'
			},
			{
				label: m.admin_common_delete(),
				iconName: 'trash',
				variant: 'outline',
				actionId: 'topics:delete'
			}
		],
		topic,
		related,
		pickable
	};
};

export const actions: Actions = {
	update: async ({ params, request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const name = str(form, 'name').trim();
		const slug = str(form, 'slug').trim().toLowerCase();
		const description = str(form, 'description').trim();
		const icon = str(form, 'icon').trim();
		const sortRaw = str(form, 'sortOrder').trim();

		if (!isUuid(params.id)) return fail(400, { error: m.admin_notes_topics_err_missing_id() });
		if (!name) return fail(400, { error: m.admin_notes_topics_err_name_required() });
		if (!slug) return fail(400, { error: m.admin_notes_topics_err_slug_required() });
		if (!isValidTaxonomySlug(slug)) return fail(400, { error: m.admin_taxonomy_err_slug_shape() });
		if (icon !== '' && !(NAV_ICON_NAMES as readonly string[]).includes(icon)) {
			return fail(400, { error: m.admin_notes_topics_err_icon_whitelist() });
		}
		const sortOrder = /^-?\d+$/.test(sortRaw) ? Number(sortRaw) : 0;

		// Source language is locked after creation.
		const [current] = await db
			.select({ sourceLang: topics.sourceLang })
			.from(topics)
			.where(eq(topics.id, params.id))
			.limit(1);
		if (!current) return fail(404, { error: m.admin_notes_topics_err_not_found() });

		let updated: { id: string }[];
		try {
			updated = await db
				.update(topics)
				.set({
					name,
					slug,
					description,
					icon: icon === '' ? null : icon,
					sortOrder,
					nameI18n: parseTaxonomyI18n(form, 'name', current.sourceLang),
					descriptionI18n: parseTaxonomyI18n(form, 'description', current.sourceLang)
				})
				.where(eq(topics.id, params.id))
				.returning({ id: topics.id });
		} catch (caught) {
			if (pgErrorCode(caught) === '23505') {
				return fail(409, { error: m.admin_notes_topics_err_duplicate() });
			}
			throw caught;
		}
		// A vanished row must not answer success.
		if (updated.length === 0) return fail(404, { error: m.admin_notes_topics_err_not_found() });
		return { success: true };
	},

	/** ▲/▼: deterministic full-list renumber inside one transaction. */
	move: async ({ params, request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const direction = str(form, 'direction');
		if (!isUuid(params.id)) return fail(400, { error: m.admin_notes_topics_err_missing_id() });
		if (direction !== 'up' && direction !== 'down')
			return fail(400, { error: m.admin_notes_topics_err_bad_direction() });

		const result = await db.transaction(async (tx) => {
			const ordered = await tx
				.select({ id: topics.id })
				.from(topics)
				.orderBy(asc(topics.sortOrder), asc(topics.name));
			const index = ordered.findIndex((row) => row.id === params.id);
			if (index < 0) return { kind: 'not-found' as const };
			const target = direction === 'up' ? index - 1 : index + 1;
			if (target < 0 || target >= ordered.length) return { kind: 'edge' as const };

			const swapped = [...ordered];
			[swapped[index], swapped[target]] = [swapped[target], swapped[index]];
			for (let position = 0; position < swapped.length; position += 1) {
				await tx
					.update(topics)
					.set({ sortOrder: position })
					.where(eq(topics.id, swapped[position].id));
			}
			return { kind: 'moved' as const };
		});

		if (result.kind === 'not-found')
			return fail(404, { error: m.admin_notes_topics_err_not_found() });
		return { success: true };
	},

	/**
	 * File or unfile notes under this topic. Unlike categories there is no
	 * destination to pick: `notes.topic_id` is SET NULL, so "clear out" simply
	 * leaves the notes unfiled and no fallback bucket is needed.
	 */
	link: async ({ params, request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const noteIds = form.getAll('noteId').map(String).filter(isUuid);
		if (noteIds.length === 0) return fail(400, { error: m.admin_notes_topics_err_no_selection() });
		if (!isUuid(params.id)) return fail(400, { error: m.admin_notes_topics_err_missing_id() });

		const op = str(form, 'op');
		if (op === 'detach') {
			await db.update(notes).set({ topicId: null }).where(inArray(notes.id, noteIds));
		} else if (op === 'attach') {
			await db.update(notes).set({ topicId: params.id }).where(inArray(notes.id, noteIds));
		} else {
			return fail(400, { error: m.admin_notes_topics_err_no_selection() });
		}
		return { success: true, changed: noteIds.length };
	},

	delete: async ({ params }) => {
		await requireAdminRole();
		if (!isUuid(params.id)) return fail(400, { error: m.admin_notes_topics_err_missing_id() });

		// The notes FK is SET NULL, so the "still owns notes" refusal must be
		// explicit here (categories mirror the same intent with a RESTRICT FK).
		// Lock + count + delete share ONE transaction: the old count-then-delete
		// pair raced with concurrent writes.
		const result = await db.transaction(async (tx) => {
			const [topic] = await tx
				.select({ id: topics.id })
				.from(topics)
				.where(eq(topics.id, params.id))
				.limit(1)
				.for('update');
			if (!topic) return { kind: 'not-found' as const };
			const [counts] = await tx
				.select({ total: sql<number>`count(*)`.mapWith(Number) })
				.from(notes)
				.where(eq(notes.topicId, params.id));
			if ((counts?.total ?? 0) > 0) {
				return { kind: 'blocked' as const, total: counts?.total ?? 0 };
			}
			await tx.delete(topics).where(eq(topics.id, params.id));
			return { kind: 'deleted' as const };
		});

		if (result.kind === 'not-found')
			return fail(404, { error: m.admin_notes_topics_err_not_found() });
		if (result.kind === 'blocked') {
			return fail(409, {
				error: m.admin_notes_topics_err_in_use({ count: result.total })
			});
		}
		return { success: true, deleted: params.id };
	}
};

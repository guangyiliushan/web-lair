import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { notes, topics } from '$lib/server/db/content';
import { requireAdminRole } from '$lib/server/authz';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import {
	discardNoteDraft,
	isNotePlaceholderSlug,
	loadNoteDraftByNoteId,
	publishNoteDraft,
	saveNoteDraftWork,
	setNoteAllowComment,
	setNoteEmotions,
	setNotePassword,
	setNotePin,
	setNoteStatus
} from '$lib/server/services/note-drafts';
import { NOTE_MOODS } from '$lib/utils/note-meta';
import { isUuid } from '$lib/utils/uuid';
import type { PageServerLoad, Actions } from './$types';

/**
 * N1 notes editor (ledger §9.10 / §13.4): the notes row is the published
 * version and is only written by the publish transaction; text editing goes
 * through one `drafts` row per target. Publish parameters and row-level
 * settings (pin_at / allow_comment / password_hash / meta.emotions) travel
 * as ACTION PARAMETERS, never through drafts (§2.3 contract).
 */

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();

	const [allTopics, defaultLang] = await Promise.all([
		db
			.select({ id: topics.id, name: topics.name, slug: topics.slug })
			.from(topics)
			.orderBy(topics.sortOrder, topics.name),
		getOption('site.default_lang')
	]);
	const langs: string[] = [...OPTION_LANGS];

	// ?id= loads an existing note; without it this page creates a new note.
	const id = url.searchParams.get('id');
	if (id && !isUuid(id)) error(404, '手记不存在');

	let note = null;
	let draft = null;
	let siblings: { id: string; lang: string; status: string }[] = [];

	if (id) {
		const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
		if (!row) error(404, '手记不存在');
		note = {
			id: row.id,
			nid: row.nid,
			title: row.title,
			slug: row.slug,
			lang: row.lang,
			status: row.status,
			tz: row.tz,
			publishedAt: row.publishedAt,
			pinAt: row.pinAt,
			topicId: row.topicId,
			mood: row.mood,
			weatherCode: row.weatherCode,
			temperatureC: row.temperatureC,
			coordinates: row.coordinates,
			location: row.location,
			locked: row.passwordHash !== null,
			allowComment: row.allowComment,
			emotions: Array.isArray(row.meta?.emotions) ? (row.meta.emotions as string[]) : [],
			placeholder: isNotePlaceholderSlug(row.slug),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt
		};

		const draftRow = await loadNoteDraftByNoteId(row.id);
		if (draftRow) {
			draft = {
				id: draftRow.id,
				version: draftRow.version,
				title: draftRow.title,
				slug: draftRow.slug,
				topicId: draftRow.topicId,
				mood: draftRow.mood,
				weatherCode: draftRow.weatherCode,
				temperatureC: draftRow.temperatureC,
				coordinates: draftRow.coordinates,
				location: draftRow.location,
				content: draftRow.content,
				updatedAt: draftRow.updatedAt
			};
		}

		siblings = await db
			.select({ id: notes.id, lang: notes.lang, status: notes.status })
			.from(notes)
			.where(and(eq(notes.translationGroup, row.translationGroup), ne(notes.id, row.id)));
	}

	return {
		headerTitle: '手记',
		headerActions: [
			{ label: '返回', iconName: 'arrow-left', variant: 'outline', href: '/admin/notes' }
		],
		topics: allTopics,
		langs,
		defaultLang,
		note,
		draft,
		siblings
	};
};

export const actions: Actions = {
	/**
	 * Autosave (`autosave=1`) and the manual "保存草稿" share this action;
	 * conflicts answer 409 so the client refuses to overwrite (§9.10).
	 */
	save: async ({ request, locals }) => {
		await requireAdminRole();
		const form = await request.formData();
		const rawId = str(form, 'id').trim();
		const draftId = str(form, 'draftId').trim();
		const versionRaw = str(form, 'draftVersion').trim();
		const langRaw = str(form, 'lang').trim();
		const autosave = form.get('autosave') === '1';
		if (rawId && !isUuid(rawId)) return fail(400, { message: '手记标识无效' });
		if (draftId && !isUuid(draftId)) return fail(400, { message: '草稿标识无效' });
		// Malformed ids must never reach a uuid column (22P02 → 500).
		const topicIdRaw = str(form, 'topicId').trim();
		if (topicIdRaw && !isUuid(topicIdRaw)) {
			return fail(400, { message: '专栏标识无效' });
		}
		// Closed vocabulary write-side guard (notes plan §8.1).
		const moodRaw = str(form, 'mood').trim();
		if (moodRaw && !(NOTE_MOODS as readonly string[]).includes(moodRaw)) {
			return fail(400, { message: '心情取值无效' });
		}

		const result = await saveNoteDraftWork({
			draftId: draftId || null,
			noteId: rawId || null,
			// A non-numeric version is treated as "not provided" (mirrors the
			// posts editor's permanent-409 review finding).
			expectedVersion: /^\d+$/.test(versionRaw) ? Number(versionRaw) : null,
			lang: (OPTION_LANGS as readonly string[]).includes(langRaw) ? langRaw : null,
			payload: {
				title: str(form, 'title'),
				slug: str(form, 'slug').trim().toLowerCase(),
				topicId: topicIdRaw,
				mood: moodRaw,
				weatherCode: str(form, 'weatherCode').trim(),
				temperatureC: str(form, 'temperatureC'),
				latitude: str(form, 'latitude'),
				longitude: str(form, 'longitude'),
				location: str(form, 'location'),
				content: str(form, 'content')
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
					noteId: result.noteId || null,
					updatedAt: result.updatedAt
				};
			case 'unchanged':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					noteId: result.noteId || null
				};
			case 'throttled':
				return {
					saved: false,
					reason: result.kind,
					draftId: result.draftId,
					draftVersion: result.version,
					noteId: result.noteId || null,
					retryAfterMs: result.retryAfterMs
				};
			case 'not-found':
				return fail(404, { message: '手记不存在' });
			case 'conflict':
				return fail(409, {
					conflict: true,
					server: result.server,
					message: '内容已在其他窗口更新，请以服务端为准刷新后再编辑'
				});
		}
	},

	/** Publish transaction: copy the locked draft onto the notes row. */
	publish: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId)) return fail(400, { message: '草稿标识无效' });

		const result = await publishNoteDraft(draftId);
		switch (result.kind) {
			case 'published':
				throw redirect(303, `/admin/notes/edit?id=${result.noteId}&published=1`);
			case 'invalid':
				return fail(400, { errors: result.errors, message: '发布校验未通过' });
			case 'slug-taken':
				return fail(400, { errors: { slug: '该 Slug 已被其他手记使用' } });
			case 'busy':
				return fail(409, { message: '并发操作冲突，请稍后重试' });
			case 'not-found':
				return fail(404, { message: '草稿不存在' });
		}
	},

	/** Explicit discard: a never-published note goes with its draft. */
	discard: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const draftId = str(form, 'draftId').trim();
		if (!draftId || !isUuid(draftId)) return fail(400, { message: '草稿标识无效' });

		const result = await discardNoteDraft(draftId);
		if (result.kind === 'not-found') return fail(404, { message: '草稿不存在' });
		if (result.kind === 'busy') return fail(409, { message: '并发操作冲突，请稍后重试' });
		if (result.removedPlaceholder) throw redirect(303, '/admin/notes?discarded=1');
		if (result.noteId) throw redirect(303, `/admin/notes/edit?id=${result.noteId}&discarded=1`);
		throw redirect(303, '/admin/notes?discarded=1');
	},

	/** Row-level status actions: 转 private / 入 trash / trash 恢复. */
	status: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		const action = str(form, 'action').trim();
		if (!id || !isUuid(id)) return fail(400, { message: '手记标识无效' });
		if (action !== 'private' && action !== 'trash' && action !== 'restore') {
			return fail(400, { message: '动作无效' });
		}

		const result = await setNoteStatus(id, action);
		if (result.kind === 'not-found') return fail(404, { message: '手记不存在' });
		if (action === 'trash') throw redirect(303, '/admin/notes?trashed=1');
		throw redirect(
			303,
			`/admin/notes/edit?id=${id}&${action === 'private' ? 'private' : 'restored'}=1`
		);
	},

	/** Pin toggle (publish parameter - never staged in drafts). */
	pin: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: '手记标识无效' });
		const result = await setNotePin(id, str(form, 'value') === '1');
		if (result.kind === 'not-found') return fail(404, { message: '手记不存在' });
		return { success: true };
	},

	/** Per-note comment switch (publish parameter - never staged). */
	comments: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: '手记标识无效' });
		const result = await setNoteAllowComment(id, str(form, 'value') === '1');
		if (result.kind === 'not-found') return fail(404, { message: '手记不存在' });
		return { success: true };
	},

	/** Emotions live in meta (fail-closed against the 38-token vocabulary). */
	emotions: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: '手记标识无效' });
		const tokens = form.getAll('emotions').map((value) => value.toString());
		const result = await setNoteEmotions(id, tokens);
		if (result.kind === 'not-found') return fail(404, { message: '手记不存在' });
		if (result.kind === 'invalid') return fail(400, { message: result.message });
		return { success: true };
	},

	/** Password gate arm/disarm ('' clears; a change revokes every unlock). */
	password: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id').trim();
		if (!id || !isUuid(id)) return fail(400, { message: '手记标识无效' });
		const password = str(form, 'password');
		const result = await setNotePassword(id, form.get('clear') === '1' ? '' : password);
		if (result.kind === 'not-found') return fail(404, { message: '手记不存在' });
		if (result.kind === 'invalid') return fail(400, { message: result.message });
		return { success: true };
	}
};

import { fail } from '@sveltejs/kit';
import { requireAdminRole } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import { getOption } from '$lib/server/config/options-registry';
import { zonedNaiveOf, zonedNaiveToUtc } from '$lib/server/media/exif';
import { MAX_BATCH_COUNT, MAX_UPLOAD_BYTES } from '$lib/server/media/sniff';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { uploadFiles, UploadRejected } from '$lib/server/services/files';
import {
	PHOTO_LIST_LIMIT,
	addPhotoTags,
	createPhotoFromFile,
	listAdminPhotos,
	listTagOptions,
	removePhoto,
	updatePhoto
} from '$lib/server/services/photos';
import type { PageServerLoad, Actions } from './$types';

/**
 * Admin gallery (§6.2): grid + filters, batch ops (visibility / tags /
 * delete), the edit drawer and the upload entry (upload -> registry ->
 * gallery; the bulk importer stays on the CLI: `pnpm media:import`).
 */

const SINCE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;
const UPLOAD_RATE_LIMIT = { limit: 60, windowSeconds: 10 * 60 };
const VISIBILITIES = ['all', 'visible', 'hidden'] as const;
const LOCALES = ['en', 'zh-cn', 'ja'] as const;

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const visibilityParam = url.searchParams.get('visibility');
	const visibility = VISIBILITIES.find((value) => value === visibilityParam) ?? 'all';
	const location = url.searchParams.get('location') === '1';
	const tagParam = url.searchParams.get('tag') ?? '';
	const sinceParam = url.searchParams.get('since') ?? '';
	const keyword = url.searchParams.get('keyword') ?? '';
	const sinceDays = SINCE_DAYS[sinceParam as keyof typeof SINCE_DAYS];

	const [rows, tagOptions, siteTz] = await Promise.all([
		listAdminPhotos({
			visibility: visibility === 'all' ? undefined : visibility === 'visible',
			hasLocation: location,
			tagId: isUuid(tagParam) ? tagParam : undefined,
			since: sinceDays ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) : undefined,
			slugKeyword: keyword
		}),
		listTagOptions(),
		getOption('site.timezone')
	]);

	return {
		headerTitle: '图床',
		photos: rows.map((row) => ({
			...row,
			// The drawer's datetime-local value, rendered in the site timezone.
			takenAtLocal: row.takenAt ? zonedNaiveOf(new Date(row.takenAt), siteTz) : ''
		})),
		tagOptions,
		siteTz,
		listTruncated: rows.length >= PHOTO_LIST_LIMIT,
		filters: {
			visibility,
			location,
			tag: isUuid(tagParam) ? tagParam : '',
			since: sinceDays ? sinceParam : '',
			keyword
		},
		limits: { maxBytes: MAX_UPLOAD_BYTES, maxBatch: MAX_BATCH_COUNT }
	};
};

function str(form: FormData, key: string): string {
	return (form.get(key) ?? '').toString();
}

/** Same shape as the pages editor: empty strings mean "locale absent". */
function localizedFrom(form: FormData, prefix: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const locale of LOCALES) {
		const value = str(form, `${prefix}_${locale}`).trim();
		if (value !== '') result[locale] = value;
	}
	return result;
}

function tagNamesFrom(form: FormData): string[] {
	return str(form, 'tags')
		.split(/[,\n]+/)
		.map((name) => name.trim())
		.filter((name) => name !== '');
}

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		await requireAdminRole();
		// Same fail-open seatbelt as /admin/files (plan §7).
		const rate = await rateLimit(
			getCache(),
			`limits:upload:${locals.user?.id ?? 'anonymous'}`,
			UPLOAD_RATE_LIMIT.limit,
			UPLOAD_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) return fail(429, { message: '上传过于频繁，请稍后再试' });
		const form = await request.formData();
		const uploads = form
			.getAll('files')
			.filter((entry): entry is File => entry instanceof File && entry.size > 0);
		if (uploads.length === 0) return fail(400, { message: '请选择要上传的图片' });
		if (uploads.length > MAX_BATCH_COUNT) {
			return fail(400, { message: `一次最多上传 ${MAX_BATCH_COUNT} 个文件` });
		}
		const oversized = uploads.find((file) => file.size > MAX_UPLOAD_BYTES);
		if (oversized) return fail(400, { message: `${oversized.name} 超过单文件上限` });

		try {
			const results = await uploadFiles(
				await Promise.all(
					uploads.map(async (file) => ({
						fileName: file.name,
						bytes: new Uint8Array(await file.arrayBuffer()),
						uploadedBy: locals.user?.id ?? null
					}))
				)
			);
			const enriched = [];
			for (const result of results) {
				if (!result.ok || !result.file) {
					enriched.push({ ...result, added: false, galleryError: null });
					continue;
				}
				const created = await createPhotoFromFile(result.file.id);
				enriched.push({
					...result,
					added: created.kind === 'ok' || created.kind === 'already-in-gallery',
					galleryError:
						created.kind === 'not-image'
							? '非图片文件（已入内容资产）'
							: created.kind === 'source-missing'
								? '对象缺失，未入图床'
								: null
				});
			}
			return { uploadResults: enriched };
		} catch (error) {
			if (error instanceof UploadRejected) return fail(400, { message: error.message });
			throw error;
		}
	},

	update: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		if (!isUuid(id)) return fail(400, { message: '照片标识无效' });

		const siteTz = await getOption('site.timezone');
		const takenRaw = str(form, 'takenAt').trim();
		let takenAt: Date | null = null;
		if (takenRaw !== '') {
			takenAt = zonedNaiveToUtc(takenRaw.slice(0, 16), siteTz);
			if (!takenAt) return fail(400, { message: '拍摄时间格式无效' });
		}

		const result = await updatePhoto(id, {
			title: localizedFrom(form, 'title'),
			description: localizedFrom(form, 'description'),
			slug: str(form, 'slug'),
			takenAt,
			isVisible: form.get('isVisible') !== null,
			tags: tagNamesFrom(form)
		});
		if (result.kind === 'not-found') return fail(404, { message: '照片不存在' });
		if (result.kind === 'slug-invalid') {
			return fail(400, { message: 'Slug 仅允许字母、数字、连字符（中文等文字保留）' });
		}
		if (result.kind === 'slug-taken') return fail(409, { message: 'Slug 已存在' });
		return { saved: true };
	},

	bulk: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const ids = form
			.getAll('ids')
			.map((value) => value.toString())
			.filter((value) => isUuid(value));
		const op = str(form, 'op');
		if (ids.length === 0) return fail(400, { message: '请先选择照片' });
		if (!['show', 'hide', 'tag', 'delete'].includes(op)) {
			return fail(400, { message: '未知批量操作' });
		}
		if (op === 'tag' && tagNamesFrom(form).length === 0) {
			return fail(400, { message: '请输入标签名' });
		}
		let done = 0;
		let failed = 0;
		for (const id of ids) {
			try {
				if (op === 'show' || op === 'hide') {
					const result = await updatePhoto(id, { isVisible: op === 'show' });
					if (result.kind === 'ok') done += 1;
					else failed += 1;
				} else if (op === 'tag') {
					await addPhotoTags(id, tagNamesFrom(form));
					done += 1;
				} else {
					const result = await removePhoto(id);
					if (result.kind === 'ok') done += 1;
					else failed += 1;
				}
			} catch {
				failed += 1;
			}
		}
		return { bulkResult: { op, done, failed } };
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = str(form, 'id');
		if (!isUuid(id)) return fail(400, { message: '照片标识无效' });
		const removeFile = form.get('removeFile') !== null;
		const result = await removePhoto(id, { removeFile });
		if (result.kind === 'not-found') return fail(404, { message: '照片不存在' });
		return {
			deleted: { removeFile, fileDeleted: result.fileDeleted, fileBlocked: result.fileBlocked }
		};
	}
} satisfies Actions;

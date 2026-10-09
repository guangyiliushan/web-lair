import { fail, redirect } from '@sveltejs/kit';
import { requireAdminRole } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import {
	FILE_LIST_LIMIT,
	deleteFile,
	listFiles,
	listPurgeCandidates,
	runMediaAudit,
	uploadFiles,
	UploadRejected
} from '$lib/server/services/files';
import { createPhotoFromFile } from '$lib/server/services/photos';
import { MAX_BATCH_COUNT, MAX_UPLOAD_BYTES } from '$lib/server/media/sniff';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import type { PageServerLoad, Actions } from './$types';

/**
 * Content assets admin (storage line §6.1): registry list with filters, batch
 * upload, reference-guarded delete, plus the three-check audit and the purge
 * dry-run — both read-only; the actual purge stays on the CLI (`media:purge
 * --yes`). Uploads keep the ST-1 contract: whitelist + magic sniffing + size
 * caps live in the service, never in the form.
 */

const KINDS = ['image', 'file'] as const;
const STATUSES = ['pending', 'attached', 'detached'] as const;
/** §6.1 time filter presets (URL state). */
const SINCE_DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

/** Upload rate window (plan §7): generous for a single admin, still bounded. */
const UPLOAD_RATE_LIMIT = { limit: 60, windowSeconds: 10 * 60 };

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const kindParam = url.searchParams.get('kind');
	const statusParam = url.searchParams.get('status');
	const keyword = url.searchParams.get('keyword') ?? '';
	const sinceParam = url.searchParams.get('since') ?? '';
	const orphan = url.searchParams.get('orphan') === '1';
	const kind = KINDS.find((value) => value === kindParam);
	const status = STATUSES.find((value) => value === statusParam);
	const sinceDays = SINCE_DAYS[sinceParam as keyof typeof SINCE_DAYS];
	const since = sinceDays ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) : undefined;

	const files = await listFiles({ kind, status, keyword, since, orphan });

	return {
		headerTitle: '文件',
		files,
		// The list is capped at FILE_LIST_LIMIT rows — surface it (round-2).
		listTruncated: files.length >= FILE_LIST_LIMIT,
		filters: {
			kind: kind ?? '',
			status: status ?? '',
			keyword,
			since: sinceDays ? sinceParam : '',
			orphan
		},
		limits: { maxBytes: MAX_UPLOAD_BYTES, maxBatch: MAX_BATCH_COUNT }
	};
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		await requireAdminRole();
		// Fail-open counter (plan §7): a seatbelt against runaway POSTs, never
		// a gate — a dead Valkey still lets every upload through.
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
		if (uploads.length === 0) return fail(400, { message: '请选择要上传的文件' });
		// Reject oversized batches before copying bodies; the service keeps its
		// own cap as the authoritative contract (batch-too-large, plan §4.2).
		if (uploads.length > MAX_BATCH_COUNT) {
			return fail(400, { message: `一次最多上传 ${MAX_BATCH_COUNT} 个文件` });
		}
		// Early reject oversized files before copying bodies; the service keeps
		// the authoritative check (plan §4.2).
		const oversized = uploads.find((file) => file.size > MAX_UPLOAD_BYTES);
		if (oversized) {
			return fail(400, { message: `${oversized.name} 超过单文件上限` });
		}

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
			return { uploadResults: results };
		} catch (error) {
			if (error instanceof UploadRejected) return fail(400, { message: error.message });
			throw error;
		}
	},

	delete: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: '文件标识无效' });

		const result = await deleteFile(id);
		if (result.kind === 'not-found') return fail(404, { message: '文件不存在' });
		if (result.kind === 'referenced') {
			const parts: string[] = [];
			if (result.refCount > 0) parts.push(`内容引用 ${result.refCount} 处`);
			if (result.isInGallery) parts.push('图床引用');
			return fail(409, { message: `仍被引用（${parts.join('、')}），不能删除` });
		}
		throw redirect(303, '/admin/files?deleted=1');
	},

	addToGallery: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: '文件标识无效' });
		const result = await createPhotoFromFile(id);
		if (result.kind === 'not-found') return fail(404, { message: '文件不存在' });
		if (result.kind === 'not-image') return fail(400, { message: '仅图片可加入图床' });
		if (result.kind === 'source-missing') return fail(409, { message: '对象缺失，无法加入图床' });
		return {
			galleryAdded: { kind: result.kind, slug: result.kind === 'ok' ? result.slug : null }
		};
	},

	audit: async () => {
		await requireAdminRole();
		return { audit: await runMediaAudit() };
	},

	purgePreview: async () => {
		await requireAdminRole();
		return { purge: await listPurgeCandidates() };
	}
} satisfies Actions;

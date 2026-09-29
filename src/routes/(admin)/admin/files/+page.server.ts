import { fail, redirect } from '@sveltejs/kit';
import { requireAdminRole } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import {
	deleteFile,
	listFiles,
	listPurgeCandidates,
	runMediaAudit,
	uploadFiles,
	UploadRejected
} from '$lib/server/services/files';
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

/** Upload rate window (plan §7): generous for a single admin, still bounded. */
const UPLOAD_RATE_LIMIT = { limit: 60, windowSeconds: 10 * 60 };

export const load: PageServerLoad = async ({ url }) => {
	await requireAdminRole();
	const kindParam = url.searchParams.get('kind');
	const statusParam = url.searchParams.get('status');
	const keyword = url.searchParams.get('keyword') ?? '';
	const kind = KINDS.find((value) => value === kindParam);
	const status = STATUSES.find((value) => value === statusParam);

	const files = await listFiles({ kind, status, keyword });

	return {
		headerTitle: '文件',
		files,
		filters: { kind: kind ?? '', status: status ?? '', keyword },
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
			if (result.isPhoto) parts.push('图床引用');
			return fail(409, { message: `仍被引用（${parts.join('、')}），不能删除` });
		}
		throw redirect(303, '/admin/files?deleted=1');
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

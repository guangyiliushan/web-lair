import { fail, redirect } from '@sveltejs/kit';
import { requireAdminRole } from '$lib/server/authz';
import { isUuid } from '$lib/utils/uuid';
import {
	FILE_LIST_LIMIT,
	UPLOAD_RATE_LIMIT,
	deleteFile,
	listFiles,
	listPurgeCandidates,
	runMediaAudit,
	uploadFiles,
	uploadRateLimitKey,
	UploadRejected
} from '$lib/server/services/files';
import { createPhotoFromFile } from '$lib/server/services/photos';
import { MAX_BATCH_COUNT, MAX_UPLOAD_BYTES } from '$lib/server/media/sniff';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import type { PageServerLoad, Actions } from './$types';
import { m } from '$lib/paraglide/messages';

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
		headerTitle: m.admin_nav_files(),
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
			uploadRateLimitKey(locals.user?.id),
			UPLOAD_RATE_LIMIT.limit,
			UPLOAD_RATE_LIMIT.windowSeconds
		);
		if (!rate.allowed) return fail(429, { message: m.admin_media_err_rate() });
		const form = await request.formData();
		const uploads = form
			.getAll('files')
			.filter((entry): entry is File => entry instanceof File && entry.size > 0);
		if (uploads.length === 0) return fail(400, { message: m.admin_files_err_no_files() });
		// Reject oversized batches before copying bodies; the service keeps its
		// own cap as the authoritative contract (batch-too-large, plan §4.2).
		if (uploads.length > MAX_BATCH_COUNT) {
			return fail(400, { message: m.admin_media_err_too_many({ count: MAX_BATCH_COUNT }) });
		}
		// Early reject oversized files before copying bodies; the service keeps
		// the authoritative check (plan §4.2).
		const oversized = uploads.find((file) => file.size > MAX_UPLOAD_BYTES);
		if (oversized) {
			return fail(400, { message: m.admin_media_err_too_big({ name: oversized.name }) });
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
		if (!isUuid(id)) return fail(400, { message: m.admin_files_err_bad_id() });

		const result = await deleteFile(id);
		if (result.kind === 'not-found') return fail(404, { message: m.admin_files_err_not_found() });
		if (result.kind === 'mentioned') {
			// A truncated scan is fail-closed, not a content hit (round-2
			// confirm P3): surface the real reason instead of a false claim.
			return fail(409, {
				message: result.scanTruncated
					? m.admin_files_err_scan_cap()
					: m.admin_files_err_still_mentioned()
			});
		}
		if (result.kind === 'referenced') {
			const parts: string[] = [];
			if (result.refCount > 0) parts.push(m.admin_files_ref_count({ count: result.refCount }));
			if (result.isInGallery) parts.push(m.admin_files_gallery_ref());
			return fail(409, {
				message: m.admin_files_err_in_use({ parts: parts.join(m.admin_files_join()) })
			});
		}
		throw redirect(303, '/admin/files?deleted=1');
	},

	addToGallery: async ({ request }) => {
		await requireAdminRole();
		const form = await request.formData();
		const id = (form.get('id') ?? '').toString();
		if (!isUuid(id)) return fail(400, { message: m.admin_files_err_bad_id() });
		const result = await createPhotoFromFile(id);
		if (result.kind === 'not-found') return fail(404, { message: m.admin_files_err_not_found() });
		if (result.kind === 'not-image') return fail(400, { message: m.admin_files_err_not_image() });
		if (result.kind === 'source-missing')
			return fail(409, { message: m.admin_files_err_source_missing() });
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

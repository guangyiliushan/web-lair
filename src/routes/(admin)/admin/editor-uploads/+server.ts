import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { UploadRejected, listFiles, uploadFile } from '$lib/server/services/files';
import { listAdminPhotos } from '$lib/server/services/photos';
import { photoTileSrc } from '$lib/components/photos/photo-tile';
import { MAX_UPLOAD_BYTES } from '$lib/server/media/sniff';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';

/**
 * Editor image uploads (ST-3 3a, storage plan §9): one file per request -
 * the Lexical client uploads 1-3 pasted/dropped images concurrently and
 * inserts each result as it lands, so per-file retry stays trivial (Q10
 * ruling, 2026-10-12).
 *
 * A JSON endpoint rather than a form action: kit's docs route non-form
 * interactions to `+server` (form-actions "Alternatives"); multipart bodies
 * are still covered by the built-in CSRF origin check (respond.js), and the
 * client must send `Accept: application/json` to receive the JSON wrapper on
 * a CSRF rejection.
 *
 * Auth is a boolean surface (never redirect()): a fetch client needs a
 * decidable 401/403 JSON answer, not a 303 it would follow into HTML (Q2
 * ruling). The upload reuses the shared pipeline - sniff whitelist, 25MB
 * cap, content-addressed dedupe - and the same fail-open rate bucket as the
 * admin files page (`limits:upload:<uid>`, 60/10min, plan §7).
 *
 * Codes: unauthorized(401) / forbidden(403) / throttled(429) / empty(400) /
 * too-large(413) / unsupported-type(415) / server-error(500). URLs: GIFs
 * take the bare key (the original IS the public tier, plan §4.3); everything
 * else MUST carry a variant suffix - anonymous reads of bare non-GIF keys
 * are 404s (Q11 constraint, applies to every body insertion incl. P5).
 */

const UPLOAD_RATE_LIMIT = { limit: 60, windowSeconds: 10 * 60 };

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.admin) {
		return locals.user
			? json({ code: 'forbidden' }, { status: 403 })
			: json({ code: 'unauthorized' }, { status: 401 });
	}

	const rate = await rateLimit(
		getCache(),
		`limits:upload:${locals.user?.id ?? 'anonymous'}`,
		UPLOAD_RATE_LIMIT.limit,
		UPLOAD_RATE_LIMIT.windowSeconds
	);
	if (!rate.allowed) return json({ code: 'throttled' }, { status: 429 });

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ code: 'empty' }, { status: 400 });
	}
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0) return json({ code: 'empty' }, { status: 400 });
	if (file.size > MAX_UPLOAD_BYTES) return json({ code: 'too-large' }, { status: 413 });

	try {
		const uploaded = await uploadFile({
			fileName: file.name,
			bytes: new Uint8Array(await file.arrayBuffer()),
			uploadedBy: locals.user?.id ?? null
		});
		// GIFs are the pass-through format: the original IS the public tier
		// (plan §4.3) and a bare `.gif` key serves anonymously. Everything
		// else must carry a variant suffix - bare non-GIF keys are admin-only.
		const isGif = uploaded.mimeType === 'image/gif';
		const url = isGif ? `/i/${uploaded.objectKey}` : `/i/${uploaded.objectKey}@preview`;
		const fullUrl = isGif ? url : `/i/${uploaded.objectKey}@full`;
		return json({
			id: uploaded.id,
			objectKey: uploaded.objectKey,
			url,
			fullUrl,
			width: uploaded.width,
			height: uploaded.height,
			mimeType: uploaded.mimeType,
			byteSize: uploaded.byteSize,
			deduplicated: uploaded.deduplicated
		});
	} catch (error) {
		if (error instanceof UploadRejected) {
			const status =
				error.code === 'too-large' ? 413 : error.code === 'unsupported-type' ? 415 : 400;
			return json({ code: error.code }, { status });
		}
		// Sanitized line only (house policy: driver messages never reach the
		// logs or the client).
		console.warn('[editor-uploads] upload failed', {
			error: error instanceof Error ? error.name : typeof error
		});
		return json({ code: 'server-error' }, { status: 500 });
	}
};

/* ── Picker data surface (3a2, Q12 ruling) ─────────────────────────────── */

/** Picker list cap: newest 60 per source; search narrows server-side. */
const PICKER_LIMIT = 60;

export interface PickerItem {
	id: string;
	name: string;
	url: string;
	fullUrl: string;
	width: number | null;
	height: number | null;
	mimeType: string;
	byteSize: number;
	createdAt: string;
}

function toPickerItem(
	row: {
		id: string;
		objectKey: string;
		mimeType: string;
		width: number | null;
		height: number | null;
		byteSize: number;
		createdAt: Date;
	},
	name: string
): PickerItem {
	// photoTileSrc is the single source of the tier rule (GIF bare key,
	// everything else @variant), shared with the public gallery.
	return {
		id: row.id,
		name,
		url: photoTileSrc(row, 'thumb'),
		fullUrl: photoTileSrc(row, 'full'),
		width: row.width,
		height: row.height,
		mimeType: row.mimeType,
		byteSize: row.byteSize,
		createdAt: row.createdAt.toISOString()
	};
}

/**
 * `GET /admin/editor-uploads?source=photos|files&q=` - the picker's list
 * source (Q12): newest 60 per source, substring search narrowed in SQL by
 * the services (photos by slug, files by file name; ILIKE metacharacters
 * escaped there). Unknown/missing `source` falls back to files.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.admin) {
		return locals.user
			? json({ code: 'forbidden' }, { status: 403 })
			: json({ code: 'unauthorized' }, { status: 401 });
	}
	const source = url.searchParams.get('source') === 'photos' ? 'photos' : 'files';
	const q = url.searchParams.get('q')?.trim() ?? '';
	const items =
		source === 'photos'
			? (await listAdminPhotos({ slugKeyword: q || undefined }))
					.slice(0, PICKER_LIMIT)
					.map((row) => toPickerItem(row, row.slug))
			: (await listFiles({ kind: 'image', keyword: q || undefined }))
					.slice(0, PICKER_LIMIT)
					.map((row) => toPickerItem(row, row.fileName));
	return json({ items });
};

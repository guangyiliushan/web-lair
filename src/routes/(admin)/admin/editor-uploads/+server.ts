import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	UPLOAD_RATE_LIMIT,
	UploadRejected,
	listFiles,
	uploadFile,
	uploadRateLimitKey
} from '$lib/server/services/files';
import { listAdminPhotos } from '$lib/server/services/photos';
import { photoEmbedSrc, photoTileSrc } from '$lib/components/photos/photo-tile';
import type { PickerItem } from '$lib/media/editor-uploads';
import { MAX_UPLOAD_BYTES, sniffUpload } from '$lib/server/media/sniff';
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
 * cap, content-addressed dedupe - gated to images only (this endpoint's
 * contract is body images, so attachments answer 415 before anything is
 * stored), and the shared fail-open rate bucket with the admin pages
 * (`limits:upload:<uid>`, 60/10min - single source in files.ts).
 *
 * Codes: unauthorized(401) / forbidden(403) / throttled(429) / empty(400) /
 * too-large(413) / unsupported-type(415) / server-error(500). URLs follow
 * object existence (review round 1): GIFs take the bare key (the original
 * IS the public tier, plan §4.3) and images take `@preview` only when the
 * pipeline produced one (source long edge > 2560), else `@full` - every
 * body insertion must carry a variant suffix, since anonymous reads of bare
 * non-GIF keys are 404s (Q11 constraint, applies to every body insertion
 * incl. P5).
 */

/** Admin JSON responses are never cacheable (multi-admin browsers/proxies). */
function jsonPrivate(body: unknown, status = 200): Response {
	return json(body, { status, headers: { 'cache-control': 'private, no-store' } });
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.admin) {
		return locals.user
			? jsonPrivate({ code: 'forbidden' }, 403)
			: jsonPrivate({ code: 'unauthorized' }, 401);
	}

	const rate = await rateLimit(
		getCache(),
		uploadRateLimitKey(locals.user?.id),
		UPLOAD_RATE_LIMIT.limit,
		UPLOAD_RATE_LIMIT.windowSeconds
	);
	if (!rate.allowed) return jsonPrivate({ code: 'throttled' }, 429);

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		// A malformed multipart body shares the `empty` code with a missing
		// file field - one client-side simplification (review round 1,
		// accepted as-is).
		return jsonPrivate({ code: 'empty' }, 400);
	}
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0) return jsonPrivate({ code: 'empty' }, 400);
	if (file.size > MAX_UPLOAD_BYTES) return jsonPrivate({ code: 'too-large' }, 413);

	const bytes = new Uint8Array(await file.arrayBuffer());
	// Image-only gate (review round 1): the shared pipeline also accepts
	// pdf/zip/txt/md attachments, but an attachment here would receive a
	// variant URL that never exists - and would enter the publicly
	// registered attachment class through an "image" entry. The pipeline
	// re-sniffs; this check runs before anything is stored.
	const sniffed = sniffUpload(file.name, bytes);
	if (sniffed?.kind !== 'image') return jsonPrivate({ code: 'unsupported-type' }, 415);

	try {
		const uploaded = await uploadFile({
			fileName: file.name,
			bytes,
			uploadedBy: locals.user?.id ?? null
		});
		return jsonPrivate({
			id: uploaded.id,
			objectKey: uploaded.objectKey,
			url: photoEmbedSrc(uploaded),
			fullUrl: photoTileSrc(uploaded, 'full'),
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
			return jsonPrivate({ code: error.code }, status);
		}
		// Sanitized line only (house policy: driver messages never reach the
		// logs or the client).
		console.warn('[editor-uploads] upload failed', {
			error: error instanceof Error ? error.name : typeof error
		});
		return jsonPrivate({ code: 'server-error' }, 500);
	}
};

/* ── Picker data surface (3a2, Q12 ruling) ─────────────────────────────── */

/** Picker list cap: newest 60 per source; search narrows server-side. */
const PICKER_LIMIT = 60;

/*
 * The picker payload type lives in `$lib/media/editor-uploads` - single
 * source for the endpoint, the dialog and the paste/drop plugin (review
 * round 2, Q16). The server imports the type only.
 */

function toPickerItem(
	row: {
		id: string;
		objectKey: string;
		mimeType: string;
		width: number | null;
		height: number | null;
	},
	name: string
): PickerItem {
	return {
		id: row.id,
		name,
		// Grid tile at the 480 box; the embed URL follows the existence rule
		// (photoEmbedSrc is the single source, shared with the upload arm).
		url: photoTileSrc(row, 'thumb'),
		previewUrl: photoEmbedSrc(row),
		width: row.width,
		height: row.height
	};
}

/**
 * `GET /admin/editor-uploads?source=photos|files&q=` - the picker's list
 * source (Q12): newest 60 per source, substring search narrowed in SQL by
 * the services (photos by slug, files by file name; ILIKE metacharacters
 * escaped there). Unknown/missing `source` falls back to files. The photos
 * source orders by capture time when present (`coalesce(taken_at,
 * created_at)`, photos.ts) - "newest" means shot-latest, an inherited
 * gallery rule.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.admin) {
		return locals.user
			? jsonPrivate({ code: 'forbidden' }, 403)
			: jsonPrivate({ code: 'unauthorized' }, 401);
	}
	const source = url.searchParams.get('source') === 'photos' ? 'photos' : 'files';
	// Length cap on the keyword (review round 2): ILIKE '%q%' scans the whole
	// table, so an absurd q should not buy a quadratic scan.
	const q = (url.searchParams.get('q')?.trim() ?? '').slice(0, 100);
	try {
		const items =
			source === 'photos'
				? // Mirror the public gallery: hidden photos stay out of the picker,
					// so "hidden" keeps meaning "not on the public surface" (Q15,
					// review round 2).
					(await listAdminPhotos({ slugKeyword: q || undefined, visibility: true }))
						.slice(0, PICKER_LIMIT)
						.map((row) => toPickerItem(row, row.slug))
				: (await listFiles({ kind: 'image', keyword: q || undefined }))
						.slice(0, PICKER_LIMIT)
						.map((row) => toPickerItem(row, row.fileName));
		return jsonPrivate({ items });
	} catch (error) {
		console.warn('[editor-uploads] list failed', {
			error: error instanceof Error ? error.name : typeof error
		});
		return jsonPrivate({ code: 'server-error' }, 500);
	}
};

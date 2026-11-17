import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	UPLOAD_IP_RATE_LIMIT,
	UPLOAD_RATE_LIMIT,
	UploadRejected,
	listFiles,
	uploadFile,
	uploadIpRateLimitKey,
	uploadRateLimitKey
} from '$lib/server/services/files';
import { listAdminPhotos } from '$lib/server/services/photos';
import { photoEmbedSrc, photoTileSrc } from '$lib/components/photos/photo-tile';
import type { PickerItem } from '$lib/media/editor-uploads';
import { MAX_UPLOAD_BYTES, sniffUpload } from '$lib/server/media/sniff';
import { isStorageUnavailable } from '$lib/server/storage/port';
import { getCache } from '$lib/server/cache';
import { rateLimitStrict } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { clientAddressKey } from '$lib/utils/cidr';

/**
 * Editor image uploads: one file per request — the Lexical client uploads 1-3 pasted or
 * dropped images concurrently and inserts each result as it lands, so per-file retry stays
 * trivial.
 * A JSON endpoint rather than a form action: kit routes non-form interactions to `+server`
 * (form-actions "Alternatives"); multipart bodies are covered by the app's `handleCsrf` hook,
 * and the client must send `Accept: application/json` to get the JSON wrapper on a CSRF
 * rejection.
 * Auth is a boolean surface, never `redirect()`: a fetch client needs a decidable 401/403
 * JSON answer, not a 303 it would follow into HTML.
 * The upload reuses the shared pipeline — sniff whitelist, 25MB cap, content-addressed dedupe
 * — images only (gate below), on the shared fail-open rate bucket with the admin pages
 * (`limits:upload:<uid>`, 60/10min, single source in files.ts).
 * Codes: unauthorized(401) / forbidden(403) / throttled(429) / empty(400) / too-large(413) /
 * unsupported-type(415) / server-error(500).
 * URLs follow object existence: GIFs take the bare key (the original IS the public tier);
 * images take `@preview` only when the pipeline produced one (source long edge > 2560), else
 * `@full` — every insertion must carry a variant suffix, since anonymous reads of bare
 * non-GIF keys are 404s.
 */

/** Admin JSON responses are never cacheable (multi-admin browsers/proxies). */
function jsonPrivate(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return json(body, {
		status,
		headers: { 'cache-control': 'private, no-store', ...headers }
	});
}

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!locals.admin) {
		return locals.user
			? jsonPrivate({ code: 'forbidden' }, 403)
			: jsonPrivate({ code: 'unauthorized' }, 401);
	}

	// Security endpoint: fail CLOSED, account + IPv6-/64 IP buckets.
	const address = clientAddressKey(requestAddress(getClientAddress));
	const [accountRate, addressRate] = await Promise.all([
		rateLimitStrict(
			getCache(),
			uploadRateLimitKey(locals.user?.id),
			UPLOAD_RATE_LIMIT.limit,
			UPLOAD_RATE_LIMIT.windowSeconds
		),
		rateLimitStrict(
			getCache(),
			uploadIpRateLimitKey(address),
			UPLOAD_IP_RATE_LIMIT.limit,
			UPLOAD_IP_RATE_LIMIT.windowSeconds
		)
	]);
	if (!accountRate.allowed || !addressRate.allowed) {
		const unavailable = accountRate.unavailable || addressRate.unavailable;
		return jsonPrivate(
			{ code: unavailable ? 'unavailable' : 'throttled' },
			unavailable ? 503 : 429,
			{
				'retry-after': String(
					Math.max(UPLOAD_RATE_LIMIT.windowSeconds, UPLOAD_IP_RATE_LIMIT.windowSeconds)
				)
			}
		);
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		// A malformed multipart body shares the `empty` code with a missing file
		// field - one client-side simplification.
		return jsonPrivate({ code: 'empty' }, 400);
	}
	const file = form.get('file');
	if (!(file instanceof File) || file.size === 0) return jsonPrivate({ code: 'empty' }, 400);
	if (file.size > MAX_UPLOAD_BYTES) return jsonPrivate({ code: 'too-large' }, 413);

	const bytes = new Uint8Array(await file.arrayBuffer());
	// Image-only gate: the shared pipeline also accepts pdf/zip/txt/md
	// attachments, but an attachment here would receive a variant URL that never
	// exists - and would enter the publicly registered attachment class through an
	// "image" entry. The pipeline re-sniffs; this check runs before anything is
	// stored.
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
			// 503 for the maintenance window: it is temporary and the client should
			// retry after cutover, not treat it as a bad file.
			const status =
				error.code === 'migration'
					? 503
					: error.code === 'too-large'
						? 413
						: error.code === 'unsupported-type'
							? 415
							: 400;
			return jsonPrivate({ code: error.code }, status);
		}
		// Active provider down: a retryable 503, not a bad request.
		if (isStorageUnavailable(error)) {
			return jsonPrivate({ code: 'storage-unavailable' }, 503);
		}
		// Sanitized line only (house policy: driver messages never reach the
		// logs or the client).
		console.warn('[editor-uploads] upload failed', {
			error: error instanceof Error ? error.name : typeof error
		});
		return jsonPrivate({ code: 'server-error' }, 500);
	}
};

/* ── Picker data surface ──────────────────────────────────────────────── */

/** Picker list cap: newest 60 per source; search narrows server-side. */
const PICKER_LIMIT = 60;

/*
 * The picker payload type lives in `$lib/media/editor-uploads` - single source for
 * the endpoint, the dialog and the paste/drop plugin. The server imports the type
 * only.
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
 * `GET /admin/editor-uploads?source=photos|files&q=` - the picker's list source:
 * newest 60 per source, substring search narrowed in SQL by the services (photos by
 * slug, files by file name; ILIKE metacharacters escaped there). Unknown/missing
 * `source` falls back to files. The photos source orders by capture time when
 * present (`coalesce(taken_at, created_at)`, photos.ts) - "newest" means shot-latest,
 * an inherited gallery rule.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.admin) {
		return locals.user
			? jsonPrivate({ code: 'forbidden' }, 403)
			: jsonPrivate({ code: 'unauthorized' }, 401);
	}
	const source = url.searchParams.get('source') === 'photos' ? 'photos' : 'files';
	// Length cap on the keyword: ILIKE '%q%' scans the whole table, so an absurd q
	// should not buy a quadratic scan.
	const q = (url.searchParams.get('q')?.trim() ?? '').slice(0, 100);
	try {
		const items =
			source === 'photos'
				? // Mirror the public gallery: hidden photos stay out of the picker,
					// so "hidden" keeps meaning "not on the public surface".
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

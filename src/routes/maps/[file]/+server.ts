import { error } from '@sveltejs/kit';
import { getStorage } from '$lib/server/storage';
import { StorageError } from '$lib/server/storage/port';
import type { RequestHandler } from './$types';

/**
 * PMTiles service route (plan §8): `/maps/<file>.pmtiles` streams the object
 * from RustFS with Range forwarding — a single byte range passes through and
 * the storage's 206 (Content-Range etc.) is mirrored; anything else (wrong
 * units, multi-range, malformed) serves the full object at 200. The name is
 * whitelisted to `<safe>.pmtiles` and always prefixes `maps/`: no traversal
 * and no other key space is reachable. The live RustFS Range semantics are
 * pinned by the T12 probe.
 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*\.pmtiles$/i;

export const GET: RequestHandler = async ({ params, request }) => {
	const name = params.file ?? '';
	if (!NAME_RE.test(name)) error(404, 'Not found');

	const rangeHeader = request.headers.get('range');
	let range: { start: number; end?: number } | { suffix: number } | null = null;
	if (rangeHeader) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
		if (match) {
			const [startRaw, endRaw] = [match[1]!, match[2]!];
			if (startRaw === '' && endRaw !== '') {
				// Suffix form (last N bytes) — pmtiles clients read the footer
				// this way; S3 accepts the same syntax.
				const suffix = Number(endRaw);
				if (suffix > 0) range = { suffix };
			} else if (startRaw !== '') {
				const start = Number(startRaw);
				const end = endRaw === '' ? undefined : Number(endRaw);
				if (end === undefined || end >= start) range = { start, end };
			}
		}
	}

	let object;
	try {
		object = await getStorage().get(`maps/${name}`, range ? { range } : undefined);
	} catch (caught) {
		if (caught instanceof StorageError && caught.status === 416) {
			error(416, 'Range not satisfiable');
		}
		throw caught;
	}
	if (!object) error(404, 'Not found');

	const headers = new Headers();
	if (object.contentType) headers.set('content-type', object.contentType);
	headers.set('accept-ranges', 'bytes');
	headers.set('cache-control', 'public, max-age=300');
	if (object.etag) headers.set('etag', object.etag);
	if (object.contentRange) headers.set('content-range', object.contentRange);
	if (object.byteSize !== null) headers.set('content-length', String(object.byteSize));

	return new Response(object.body, { status: object.status === 206 ? 206 : 200, headers });
};

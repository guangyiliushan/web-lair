import { error } from '@sveltejs/kit';
import { getStorage } from '$lib/server/storage';
import { StorageError } from '$lib/server/storage/port';
import type { RequestHandler } from './$types';

/**
 * PMTiles service route (plan §8): `/maps/<file>.pmtiles` streams the object
 * from RustFS with Range forwarding — a single byte range passes through and
 * the storage's 206 (Content-Range etc.) is mirrored; anything else (wrong
 * units, multi-range, malformed or precision-losing numbers) serves the full
 * object at 200. The name is whitelisted to `<safe>.pmtiles` (exact case —
 * storage keys are case-sensitive) and always prefixes `maps/`: no traversal
 * and no other key space is reachable. The live RustFS Range semantics are
 * pinned by the T12 probe.
 */
const NAME_RE = /^[a-z0-9][a-z0-9._-]*\.pmtiles$/;

/**
 * Strict single-range parser (round-2 review). `range-unit` matches
 * case-insensitively (RFC 9110 tokens). Returns:
 * - `null` — not a single `bytes=` range, or a number that is not a safe
 *   integer: a beyond-2^53 digit string would lose precision and be
 *   re-serialised as `1e+23` into the forwarded Range header;
 * - `'unsatisfiable'` — `bytes=-0` / `end < start`: no byte can satisfy it,
 *   answer 416 locally (RFC 9110 §14.2 covers unsatisfiable ranges; rejecting
 *   the invalid end<start form mirrors S3) instead of a nonsense 200.
 */
type ByteRange = { start: number; end?: number } | { suffix: number };
const RANGE_RE = /^bytes=(\d*)-(\d*)$/i;

function parseRange(header: string | null): ByteRange | 'unsatisfiable' | null {
	if (!header) return null;
	const match = RANGE_RE.exec(header.trim());
	if (!match) return null;
	const [, startRaw = '', endRaw = ''] = match;
	if (startRaw === '' && endRaw === '') return null;
	if (startRaw === '') {
		const suffix = Number(endRaw);
		if (!Number.isSafeInteger(suffix)) return null;
		return suffix > 0 ? { suffix } : 'unsatisfiable';
	}
	const start = Number(startRaw);
	if (!Number.isSafeInteger(start)) return null;
	if (endRaw === '') return { start };
	const end = Number(endRaw);
	if (!Number.isSafeInteger(end)) return null;
	return end >= start ? { start, end } : 'unsatisfiable';
}

export const GET: RequestHandler = async ({ params, request }) => {
	const name = params.file ?? '';
	if (!NAME_RE.test(name)) error(404, 'Not found');
	const key = `maps/${name}`;

	/**
	 * Local 416 with `Content-Range: bytes * /<size>` when the size is
	 * knowable (HEAD); uncached either way — an unsatisfiable answer must
	 * not be memoised as if it were a body.
	 */
	const notSatisfiable = async (): Promise<Response> => {
		const head = await getStorage()
			.head(key)
			.catch(() => null);
		const headers = new Headers({ 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
		if (head && head.byteSize !== null) {
			headers.set('content-range', `bytes */${head.byteSize}`);
		}
		return new Response(null, { status: 416, headers });
	};

	const parsed = parseRange(request.headers.get('range'));
	if (parsed === 'unsatisfiable') return notSatisfiable();

	let object;
	try {
		object = await getStorage().get(key, parsed ? { range: parsed } : undefined);
	} catch (caught) {
		if (caught instanceof StorageError && caught.status === 416) return notSatisfiable();
		throw caught;
	}
	if (!object) {
		// Plain, uncached 404 for a storage miss (a binary service route —
		// the SvelteKit HTML error body is for pages, not tiles).
		return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
	}

	const headers = new Headers();
	if (object.contentType) headers.set('content-type', object.contentType);
	headers.set('accept-ranges', 'bytes');
	headers.set('cache-control', 'public, max-age=300');
	if (object.etag) headers.set('etag', object.etag);
	if (object.contentRange) headers.set('content-range', object.contentRange);
	if (object.byteSize !== null) headers.set('content-length', String(object.byteSize));

	return new Response(object.body, { status: object.status === 206 ? 206 : 200, headers });
};

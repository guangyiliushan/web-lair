import { error } from '@sveltejs/kit';
import { getStorage } from '$lib/server/storage';
import type { RequestHandler } from './$types';

/**
 * Content media proxy (ledger §21 / plan §4.4). RustFS is loopback-only —
 * everything public flows through `/i/<key>`:
 *
 * - key grammar: `<sha[0:2]>/<sha256>.<ext>` optionally suffixed with
 *   `@thumb` / `@preview` / `@full` (derived variants, plan §3.1). Anything
 *   else is a 404 before storage is touched.
 * - variants are public and immutable (content-addressed, max-age one year).
 * - originals (the private archive, EXIF intact) are admin-only; anonymous
 *   requests see the same 404 as a missing object, so nothing leaks.
 *
 * Content-Length / Content-Type / ETag pass through from the object store.
 * (Plan §4.4 suggested reading Content-Length from the registry; variant
 * sizes are not tracked there, and the passthrough avoids a second round
 * trip. 410 semantics for purged-but-referenced keys need the registry and
 * stay registered as deferred.)
 */

const KEY_PATTERN = /^([0-9a-f]{2})\/\1[0-9a-f]{62}(\.[a-z0-9]{1,10})?(?:@(thumb|preview|full))?$/;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PRIVATE = 'private, no-store';

function resolveKey(
	params: { key?: string },
	locals: App.Locals
): { key: string; isVariant: boolean } {
	const match = KEY_PATTERN.exec(params.key ?? '');
	if (!match) throw error(404, 'Not found');
	// Groups: 1 = digest dir, 2 = extension, 3 = variant name.
	const isVariant = match[3] !== undefined;
	if (!isVariant && !locals.admin) throw error(404, 'Not found');
	return { key: match[0], isVariant };
}

export const GET: RequestHandler = async ({ params, locals }) => {
	const { key, isVariant } = resolveKey(params, locals);

	const object = await getStorage().get(key);
	if (!object) throw error(404, 'Not found');

	const headers = new Headers();
	headers.set('cache-control', isVariant ? IMMUTABLE : PRIVATE);
	if (object.contentType) headers.set('content-type', object.contentType);
	if (object.byteSize !== null) headers.set('content-length', String(object.byteSize));
	return new Response(object.body, { headers });
};

export const HEAD: RequestHandler = async ({ params, locals }) => {
	const { key, isVariant } = resolveKey(params, locals);

	const object = await getStorage().head(key);
	if (!object) throw error(404, 'Not found');

	const headers = new Headers();
	headers.set('cache-control', isVariant ? IMMUTABLE : PRIVATE);
	if (object.contentType) headers.set('content-type', object.contentType);
	headers.set('content-length', String(object.byteSize));
	if (object.etag) headers.set('etag', object.etag);
	return new Response(null, { headers });
};

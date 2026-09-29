import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { files } from '$lib/server/db/content';
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
 * - bare keys: `gif` serves publicly by design (plan §4.3 "GIF 直通" — the
 *   original IS the public tier and GIF carries no EXIF); attachments
 *   (`pdf/zip/txt/md`) serve publicly once a registry row exists, so content
 *   can link them; photo originals (the private archive, EXIF intact) stay
 *   admin-only, and anonymous requests see the same 404 as a missing object.
 *
 * Content-Length / Content-Type / ETag pass through from the object store.
 * (Plan §4.4 suggested reading Content-Length from the registry; variant
 * sizes are not tracked there, and the passthrough avoids a second round
 * trip. 410 semantics for purged-but-referenced keys need the registry and
 * stay registered as deferred.)
 */

const KEY_PATTERN = /^([0-9a-f]{2})\/\1[0-9a-f]{62}(\.[a-z0-9]{1,10})?(?:@(thumb|preview|full))?$/;

/** Attachment extensions (plan §4.2) public via the registry, not by pattern. */
const ATTACHMENT_EXTS = new Set(['pdf', 'zip', 'txt', 'md']);

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PRIVATE = 'private, no-store';

interface Access {
	key: string;
	/** true → immutable public caching; false → admin-only, no-store. */
	publicRead: boolean;
	/** Force a download for attachments (never for files browsers render). */
	attachment: boolean;
}

async function registryHasKey(objectKey: string): Promise<boolean> {
	const [row] = await db
		.select({ id: files.id })
		.from(files)
		.where(eq(files.objectKey, objectKey))
		.limit(1);
	return Boolean(row);
}

async function resolveAccess(params: { key?: string }, locals: App.Locals): Promise<Access> {
	const match = KEY_PATTERN.exec(params.key ?? '');
	if (!match) throw error(404, 'Not found');
	// Groups: 1 = digest dir, 2 = extension, 3 = variant name.
	if (match[3] !== undefined) return { key: match[0], publicRead: true, attachment: false };
	const ext = match[2]?.slice(1) ?? '';
	if (ext === 'gif') return { key: match[0], publicRead: true, attachment: false };
	const isAttachment = ATTACHMENT_EXTS.has(ext);
	if (locals.admin) return { key: match[0], publicRead: false, attachment: isAttachment };
	if (isAttachment && (await registryHasKey(match[0]))) {
		return { key: match[0], publicRead: true, attachment: true };
	}
	throw error(404, 'Not found');
}

function objectHeaders(access: Access, contentType: string | null): Headers {
	const headers = new Headers();
	headers.set('cache-control', access.publicRead ? IMMUTABLE : PRIVATE);
	headers.set('x-content-type-options', 'nosniff');
	if (access.attachment) headers.set('content-disposition', 'attachment');
	if (contentType) headers.set('content-type', contentType);
	return headers;
}

export const GET: RequestHandler = async ({ params, locals }) => {
	const access = await resolveAccess(params, locals);

	const object = await getStorage().get(access.key);
	if (!object) throw error(404, 'Not found');

	const headers = objectHeaders(access, object.contentType);
	if (object.byteSize !== null) headers.set('content-length', String(object.byteSize));
	return new Response(object.body, { headers });
};

export const HEAD: RequestHandler = async ({ params, locals }) => {
	const access = await resolveAccess(params, locals);

	const object = await getStorage().head(access.key);
	if (!object) throw error(404, 'Not found');

	const headers = objectHeaders(access, object.contentType);
	headers.set('content-length', String(object.byteSize));
	if (object.etag) headers.set('etag', object.etag);
	return new Response(null, { headers });
};

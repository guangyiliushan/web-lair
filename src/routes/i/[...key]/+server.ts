import { error } from '@sveltejs/kit';
import { isRegisteredKey } from '$lib/server/services/files';
import { buildStorageForActive, getActiveProvider } from '$lib/server/storage';
import { isStorageUnavailable, storageUnavailableResponse } from '$lib/server/storage/port';
import { getCache } from '$lib/server/cache';
import { rateLimit } from '$lib/server/cache/store';
import { KEY_PATTERN } from '$lib/media/keys';
import type { RequestHandler } from './$types';

// Content media proxy: storage is loopback-only, so every public asset flows
// through `/i/<key>`. The key grammar lives in `$lib/media/keys` (shared with the
// upload pipeline); anything that does not parse is a 404 before storage is
// touched. Variants are public and immutable (one-year max-age); GIFs and
// registered attachments are public; photo originals stay admin-only (404).

/** Public once registered: the registry, not the extension pattern, grants access. */
const ATTACHMENT_EXTS = new Set(['pdf', 'zip', 'txt', 'md']);

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PRIVATE = 'private, no-store';

/** One gallery page bursts 30+ images; the bucket only catches scrapers. */
const MEDIA_RATE_LIMIT = { limit: 300, windowSeconds: 60 } as const;

interface Access {
	key: string;
	/** true → immutable public caching; false → admin-only, no-store. */
	publicRead: boolean;
	/** Force a download for attachments (never for files browsers render). */
	attachment: boolean;
	/** Older rows predate `@grid`; serve a smaller tier until backfilled. */
	fallbackKeys?: string[];
}

async function resolveAccess(params: { key?: string }, locals: App.Locals): Promise<Access> {
	const match = KEY_PATTERN.exec(params.key ?? '');
	if (!match) throw error(404, 'Not found');
	// Groups: 1 = digest dir, 2 = extension, 3 = variant name.
	if (match[3] !== undefined) {
		const key = match[0];
		return {
			key,
			publicRead: true,
			attachment: false,
			fallbackKeys:
				match[3] === 'grid'
					? [key.replace(/@grid$/, '@thumb'), key.replace(/@grid$/, '@preview')]
					: undefined
		};
	}
	const ext = match[2]?.slice(1) ?? '';
	if (ext === 'gif') return { key: match[0], publicRead: true, attachment: false };
	const isAttachment = ATTACHMENT_EXTS.has(ext);
	if (locals.admin) return { key: match[0], publicRead: false, attachment: isAttachment };
	if (isAttachment && (await isRegisteredKey(match[0]))) {
		return { key: match[0], publicRead: true, attachment: true };
	}
	throw error(404, 'Not found');
}

function objectHeaders(
	access: Access,
	contentType: string | null,
	cacheControl = access.publicRead ? IMMUTABLE : PRIVATE
): Headers {
	const headers = new Headers();
	headers.set('cache-control', cacheControl);
	headers.set('x-content-type-options', 'nosniff');
	if (access.attachment) headers.set('content-disposition', 'attachment');
	if (contentType) headers.set('content-type', contentType);
	return headers;
}

/**
 * `getClientAddress()` throws when adapter-node cannot resolve an address (dev
 * without ADDRESS_HEADER), so a per-IP bucket is impossible then — see
 * `UNRESOLVED_BUCKET` for the fallback.
 */
let warnedMissingAddress = false;

/** Coarse shared bucket: still bounds abuse without a site-wide 429 blast radius. */
const UNRESOLVED_BUCKET = { limit: 6000, windowSeconds: 60 } as const;
const UNRESOLVED_KEY = 'limits:i:unresolved';

function warnMissingAddressOnce(): void {
	if (warnedMissingAddress) return;
	warnedMissingAddress = true;
	console.warn('[i] client address unresolved; using the coarse media bucket');
}

async function throttled(getClientAddress: () => string): Promise<boolean> {
	const address = (() => {
		try {
			return getClientAddress() || '';
		} catch {
			return '';
		}
	})();
	if (!address) {
		warnMissingAddressOnce();
		const shared = await rateLimit(
			getCache(),
			UNRESOLVED_KEY,
			UNRESOLVED_BUCKET.limit,
			UNRESOLVED_BUCKET.windowSeconds
		);
		return !shared.allowed;
	}
	const result = await rateLimit(
		getCache(),
		`limits:i:${address}`,
		MEDIA_RATE_LIMIT.limit,
		MEDIA_RATE_LIMIT.windowSeconds
	);
	return !result.allowed;
}

function tooManyRequests(): Response {
	return new Response(null, {
		status: 429,
		headers: {
			'retry-after': String(MEDIA_RATE_LIMIT.windowSeconds),
			'cache-control': 'no-store'
		}
	});
}

/**
 * Optional CDN alias (`publicBaseUrl`). When the active provider declares one,
 * public keys are 302'd to it instead of proxied; the access check runs first, so
 * private keys never reach this branch.
 */
function cdnRedirect(publicBaseUrl: string, key: string): Response {
	return new Response(null, {
		status: 302,
		headers: {
			location: `${publicBaseUrl.replace(/\/+$/, '')}/${key}`,
			'cache-control': 'public, max-age=60'
		}
	});
}

/** Resolves the live provider once: the CDN alias and the adapter share it. */
async function openStorage() {
	const active = await getActiveProvider();
	if (active.config.publicBaseUrl) return { active, storage: null };
	return { active, storage: await buildStorageForActive(active) };
}

export const GET: RequestHandler = async ({ params, locals, getClientAddress }) => {
	if (await throttled(getClientAddress)) return tooManyRequests();
	const access = await resolveAccess(params, locals);

	let object;
	let cacheControl: string | undefined;
	try {
		const { active, storage } = await openStorage();
		if (active.config.publicBaseUrl) return cdnRedirect(active.config.publicBaseUrl, access.key);
		object = await storage!.get(access.key);
		if (!object && access.fallbackKeys) {
			for (const fallbackKey of access.fallbackKeys) {
				object = await storage!.get(fallbackKey);
				if (object) {
					// Short cache: the real @grid object will replace this tier.
					cacheControl = 'public, max-age=3600';
					break;
				}
			}
		}
	} catch (caught) {
		if (isStorageUnavailable(caught)) return storageUnavailableResponse();
		throw caught;
	}
	if (!object) throw error(404, 'Not found');

	const headers = objectHeaders(access, object.contentType, cacheControl);
	if (object.byteSize !== null) headers.set('content-length', String(object.byteSize));
	if (object.etag) headers.set('etag', object.etag);
	return new Response(object.body, { headers });
};

export const HEAD: RequestHandler = async ({ params, locals, getClientAddress }) => {
	if (await throttled(getClientAddress)) return tooManyRequests();
	const access = await resolveAccess(params, locals);

	let object;
	let cacheControl: string | undefined;
	try {
		const { active, storage } = await openStorage();
		if (active.config.publicBaseUrl) return cdnRedirect(active.config.publicBaseUrl, access.key);
		object = await storage!.head(access.key);
		if (!object && access.fallbackKeys) {
			for (const fallbackKey of access.fallbackKeys) {
				object = await storage!.head(fallbackKey);
				if (object) {
					cacheControl = 'public, max-age=3600';
					break;
				}
			}
		}
	} catch (caught) {
		if (isStorageUnavailable(caught)) return storageUnavailableResponse();
		throw caught;
	}
	if (!object) throw error(404, 'Not found');

	const headers = objectHeaders(access, object.contentType, cacheControl);
	if (object.byteSize !== null) headers.set('content-length', String(object.byteSize));
	if (object.etag) headers.set('etag', object.etag);
	return new Response(null, { headers });
};

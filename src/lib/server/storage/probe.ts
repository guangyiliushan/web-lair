import { randomUUID } from 'node:crypto';
import {
	StorageError,
	assessDeletion,
	type BucketVersioning,
	type ObjectStoragePort
} from './port';
import { sanitizeProviderError } from '../settings/provider-status.ts';

/**
 * Storage connection probe (W7.3, decision Q19: "测试连接 = SSRF 探针").
 *
 * Four checks, in order, all with the configured credentials:
 *   1. HeadBucket — the bucket exists and the key can see it;
 *   2. bucket capabilities — versioning / object lock (the W7.5 guard input);
 *   3. PutObject — writing is actually allowed (a read-only key would pass 1);
 *   4. GetObject + byte compare, then DeleteObject of the probe object.
 *
 * Results are a closed status code plus a SANITIZED detail: no endpoint, no
 * key, no driver stack ever reaches the page, the option row or the audit log.
 */
export type ProbeStatus =
	'ok' | 'auth' | 'not-found' | 'timeout' | 'network' | 'write' | 'capability' | 'unknown';

export interface StorageProbeResult {
	ok: boolean;
	status: ProbeStatus;
	/** Sanitized technical detail (may be empty for `ok`). */
	message: string;
	latencyMs: number;
	checkedAt: string;
	versioning: BucketVersioning | null;
	objectLock: boolean | null;
}

export interface ProbeOptions {
	/** Injectable clock for deterministic tests. */
	clock?: () => Date;
}

/** Probe objects never collide with content-addressed media keys. */
export const PROBE_KEY_PREFIX = 'probe/';

function classify(error: unknown): { status: ProbeStatus; message: string } {
	if (error instanceof StorageError) {
		// `sanitizeProviderError` strips URLs and key=value pairs but not a bare
		// object key; a Put/Get failure message contains `probe/<uuid>.txt`, and
		// that string is persisted in `storage.status` and rendered. Scrub the
		// reserved probe prefix too.
		const detail = sanitizeProviderError(error.message).replace(/probe\/[^\s:,)]+/g, '[probe]');
		if (error.status === 0) {
			const timedOut = /timed out|abort|timeout/i.test(error.message);
			return { status: timedOut ? 'timeout' : 'network', message: detail };
		}
		if (error.status === 401 || error.status === 403) return { status: 'auth', message: detail };
		if (error.status === 404) return { status: 'not-found', message: detail };
		// A 400 with an auth-shaped S3 code is the classic "wrong key id".
		if (
			error.status === 400 &&
			(error.code === 'InvalidAccessKeyId' || error.code === 'SignatureDoesNotMatch')
		) {
			return { status: 'auth', message: detail };
		}
		return { status: 'unknown', message: detail };
	}
	return { status: 'unknown', message: sanitizeProviderError(error) };
}

/**
 * Runs the probe. `storage` is injected so the route can build a candidate
 * handle (saved provider + env credentials) and tests can supply a fake port.
 */
export async function probeStorage(
	storage: ObjectStoragePort,
	options: ProbeOptions = {}
): Promise<StorageProbeResult> {
	const clock = options.clock ?? (() => new Date());
	const started = Date.now();
	const checkedAt = clock().toISOString();
	let versioning: BucketVersioning | null = null;
	let objectLock: boolean | null = null;

	const finish = (status: ProbeStatus, message: string): StorageProbeResult => ({
		ok: status === 'ok',
		status,
		message,
		latencyMs: Date.now() - started,
		checkedAt,
		versioning,
		objectLock
	});

	try {
		await storage.headBucket();
	} catch (error) {
		const failure = classify(error);
		return finish(failure.status, failure.message);
	}

	try {
		const capabilities = await storage.bucketCapabilities();
		versioning = capabilities.versioning;
		objectLock = capabilities.objectLock;
		// Same predicate the purge/delete guards use: if the verdict is not
		// provable, a green "Connection OK" would contradict a permanently
		// refused delete. Report it here instead.
		if (!assessDeletion(capabilities).provable) {
			return finish('capability', 'Bucket capabilities could not be read');
		}
	} catch (error) {
		const failure = classify(error);
		return finish('capability', failure.message);
	}

	const key = `${PROBE_KEY_PREFIX}${randomUUID()}.txt`;
	const payload = new TextEncoder().encode(`web-lair storage probe ${checkedAt}\n`);
	try {
		await storage.put(key, payload, { contentType: 'text/plain; charset=utf-8' });
	} catch (error) {
		const failure = classify(error);
		return finish(failure.status === 'auth' ? 'auth' : 'write', failure.message);
	}

	try {
		const object = await storage.get(key);
		if (!object) return finish('write', 'Probe object was not readable after write');
		const read = new Uint8Array(await new Response(object.body).arrayBuffer());
		const same =
			read.byteLength === payload.byteLength &&
			read.every((byte, index) => byte === payload[index]);
		if (!same) return finish('write', 'Probe object read-back did not match the write');
	} catch (error) {
		const failure = classify(error);
		return finish('write', failure.message);
	} finally {
		// Best effort: the probe object must not linger. A delete failure is not
		// a connection failure, so it never flips the result.
		await storage.delete(key).catch(() => {});
	}

	return finish('ok', '');
}

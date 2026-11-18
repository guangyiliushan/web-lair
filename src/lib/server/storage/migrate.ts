import { sha256Hex } from './signature.ts';
import type { ObjectStoragePort } from './port.ts';
import { VARIANT_NAMES, variantKeyFor } from '../../media/keys.ts';

/**
 * Migration engine: the unit of work is the `files` registry, never a bucket
 * listing. Canonical objects are content-addressed (`<sha[0:2]>/<sha256>.<ext>`),
 * so the key states the hash it must have; variants are derived keys with no
 * independent truth. A copy proves itself: source GET -> sha256 (match key/DB
 * hash) -> target PUT -> target GET -> sha256 -> compare. Re-running is the
 * resume mechanism: an object already on the target with the right bytes is
 * verified, not copied again. Nothing deletes from the source - the old
 * provider stays readable until an operator removes it.
 *
 * Not covered, deliberately: `maps/*.pmtiles` objects are not in `files`
 * (published by `pnpm maps:publish`); a provider switch re-runs that script
 * against the new provider.
 */

export interface MigrationSourceRow {
	objectKey: string;
	/** Canonical sha256 (lowercase hex) from `files.content_hash`. */
	contentHash: string;
	/** Canonical byte size from `files.byte_size`. */
	byteSize: number;
}

export interface MigrationObject {
	key: string;
	/** sha256 the object must hash to (canonical keys only). */
	expectedHash: string | null;
	/** Known byte size (canonical keys only; variants are derived). */
	expectedBytes: number | null;
	kind: 'canonical' | 'variant';
}

/** Canonical rows + their derived variants, in a stable order. */
export function enumerateMigrationObjects(rows: MigrationSourceRow[]): MigrationObject[] {
	const objects: MigrationObject[] = [];
	for (const row of rows) {
		objects.push({
			key: row.objectKey,
			expectedHash: row.contentHash.toLowerCase(),
			expectedBytes: row.byteSize,
			kind: 'canonical'
		});
		for (const variant of VARIANT_NAMES) {
			objects.push({
				key: variantKeyFor(row.objectKey, variant),
				expectedHash: null,
				expectedBytes: null,
				kind: 'variant'
			});
		}
	}
	return objects;
}

export interface MigrationPlan {
	objects: MigrationObject[];
	total: number;
	canonical: number;
	variants: number;
	/** Known canonical bytes (variants have no recorded size). */
	bytes: number;
	/** Objects already present on the target (HEAD hit). */
	existingOnTarget: number;
	/** Objects still to copy (everything not already on the target). */
	pending: number;
	/**
	 * CANONICAL keys registered in the DB but absent from the source bucket —
	 * fatal: the registry and the bucket disagree, so a copy would drop media.
	 * Absent VARIANTS are normal (not every file has every variant).
	 */
	missingOnSource: string[];
	/** Variant keys absent from the source (informational; expected). */
	missingVariants: number;
}

export interface PlanOptions {
	/** HEAD the source as well (default true); false = DB-only dry run. */
	checkSource?: boolean;
}

/**
 * Dry-run plan. Every object is HEADed so the numbers reflect the buckets, not
 * just the registry; a missing source object is reported instead of silently
 * counted as copyable.
 */
export async function planMigration(
	objects: MigrationObject[],
	storage: { source: ObjectStoragePort; target: ObjectStoragePort },
	options: PlanOptions = {}
): Promise<MigrationPlan> {
	const checkSource = options.checkSource ?? true;
	let existingOnTarget = 0;
	const missingOnSource: string[] = [];
	let missingVariants = 0;

	for (const object of objects) {
		if (checkSource) {
			const head = await storage.source.head(object.key);
			if (!head) {
				if (object.kind === 'canonical') missingOnSource.push(object.key);
				else missingVariants += 1;
			}
		}
		const targetHead = await storage.target.head(object.key);
		if (targetHead) existingOnTarget += 1;
	}

	const canonicalObjects = objects.filter((object) => object.kind === 'canonical');
	return {
		objects,
		total: objects.length,
		canonical: canonicalObjects.length,
		variants: objects.length - canonicalObjects.length,
		bytes: canonicalObjects.reduce((sum, object) => sum + (object.expectedBytes ?? 0), 0),
		existingOnTarget,
		pending: objects.length - existingOnTarget,
		missingOnSource,
		missingVariants
	};
}

export interface CopyFailure {
	key: string;
	/** Closed reason code; the CLI prints it verbatim. */
	reason:
		| 'missing-source'
		| 'source-hash-mismatch'
		| 'write-failed'
		| 'read-back-missing'
		| 'read-back-mismatch';
}

export interface CopyOutcome {
	/** Objects written this run. */
	copied: number;
	/** Objects already correct on the target. */
	skipped: number;
	/** Variant keys that do not exist on the source (normal: no variant made). */
	missingVariants: number;
	/** Objects whose bytes were proven on the target (copied + skipped). */
	verified: number;
	failed: CopyFailure[];
	bytes: number;
}

export interface CopyOptions {
	/** Called after each object (index is 1-based). */
	onProgress?: (progress: { index: number; total: number; key: string; outcome: string }) => void;
	/** Called before each object; lets the CLI persist a heartbeat. */
	onBefore?: (progress: { index: number; total: number; key: string }) => Promise<void> | void;
}

/**
 * Copies or re-verifies every object. Sequential on purpose: a maintenance
 * window values predictability over throughput, and one object at a time keeps
 * memory bounded by the 25 MB upload cap.
 */
export async function copyObjects(
	objects: MigrationObject[],
	storage: { source: ObjectStoragePort; target: ObjectStoragePort },
	options: CopyOptions = {}
): Promise<CopyOutcome> {
	const outcome: CopyOutcome = {
		copied: 0,
		skipped: 0,
		missingVariants: 0,
		verified: 0,
		failed: [],
		bytes: 0
	};

	for (const [index, object] of objects.entries()) {
		await options.onBefore?.({ index: index + 1, total: objects.length, key: object.key });

		let bytes: Uint8Array;
		let contentType: string | null;
		try {
			const sourceObject = await storage.source.get(object.key);
			if (!sourceObject) {
				// A variant that was never generated is not a failure: only some
				// files have variants (GIFs, attachments, small images). A missing
				// CANONICAL object is fatal — the registry and the bucket disagree.
				if (object.kind === 'variant') {
					outcome.missingVariants += 1;
					options.onProgress?.({
						index: index + 1,
						total: objects.length,
						key: object.key,
						outcome: 'no-variant'
					});
					continue;
				}
				outcome.failed.push({ key: object.key, reason: 'missing-source' });
				options.onProgress?.({
					index: index + 1,
					total: objects.length,
					key: object.key,
					outcome: 'missing-source'
				});
				continue;
			}
			contentType = sourceObject.contentType;
			bytes = new Uint8Array(await new Response(sourceObject.body).arrayBuffer());
		} catch {
			outcome.failed.push({ key: object.key, reason: 'missing-source' });
			options.onProgress?.({
				index: index + 1,
				total: objects.length,
				key: object.key,
				outcome: 'missing-source'
			});
			continue;
		}

		const digest = sha256Hex(bytes);
		if (object.expectedHash && digest !== object.expectedHash) {
			outcome.failed.push({ key: object.key, reason: 'source-hash-mismatch' });
			options.onProgress?.({
				index: index + 1,
				total: objects.length,
				key: object.key,
				outcome: 'source-hash-mismatch'
			});
			continue;
		}

		// Resume path: an object already on the target is proven, not rewritten.
		const existing = await storage.target.head(object.key).catch(() => null);
		const alreadySized =
			existing !== null &&
			(object.expectedBytes === null || existing.byteSize === object.expectedBytes);
		if (alreadySized) {
			const verified = await verifyTargetBytes(storage.target, object, digest);
			if (verified === 'ok') {
				outcome.skipped += 1;
				outcome.verified += 1;
				options.onProgress?.({
					index: index + 1,
					total: objects.length,
					key: object.key,
					outcome: 'verified'
				});
				continue;
			}
			if (verified === 'missing') {
				outcome.failed.push({ key: object.key, reason: 'read-back-missing' });
				options.onProgress?.({
					index: index + 1,
					total: objects.length,
					key: object.key,
					outcome: 'read-back-missing'
				});
				continue;
			}
			// Bytes differ: fall through and rewrite.
		}

		try {
			await storage.target.put(object.key, bytes, contentType ? { contentType } : {});
		} catch {
			outcome.failed.push({ key: object.key, reason: 'write-failed' });
			options.onProgress?.({
				index: index + 1,
				total: objects.length,
				key: object.key,
				outcome: 'write-failed'
			});
			continue;
		}
		outcome.copied += 1;
		outcome.bytes += bytes.byteLength;

		const verified = await verifyTargetBytes(storage.target, object, digest);
		if (verified !== 'ok') {
			outcome.failed.push({
				key: object.key,
				reason: verified === 'missing' ? 'read-back-missing' : 'read-back-mismatch'
			});
			options.onProgress?.({
				index: index + 1,
				total: objects.length,
				key: object.key,
				outcome: verified
			});
			continue;
		}
		outcome.verified += 1;
		options.onProgress?.({
			index: index + 1,
			total: objects.length,
			key: object.key,
			outcome: 'copied'
		});
	}

	return outcome;
}

/**
 * Reads the target object and compares its sha256 with the bytes we copied.
 * Variants have no DB hash, but the copied bytes are the reference, so the
 * digest argument always exists.
 */
async function verifyTargetBytes(
	target: ObjectStoragePort,
	object: MigrationObject,
	expectedDigest: string
): Promise<'ok' | 'missing' | 'mismatch'> {
	const readBack = await target.get(object.key).catch(() => null);
	if (!readBack) return 'missing';
	const bytes = new Uint8Array(await new Response(readBack.body).arrayBuffer());
	return sha256Hex(bytes) === expectedDigest ? 'ok' : 'mismatch';
}

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/lib/server/db/schema';
import { MAX_UPLOAD_BYTES } from '../src/lib/server/media/sniff';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';
import { UploadRejected, uploadFile } from '../src/lib/server/services/files';
import { createPhotoFromFile } from '../src/lib/server/services/photos';
import { tagSlug } from '../src/lib/utils/slug';

/**
 * Bulk media import (plan §5.4, T13): `pnpm media:import <dir…>`.
 *
 * Whitelist scan → content-hash dedupe (files already in the library are
 * SKIPPED, so a second run is safe; changed bytes land as new rows — the
 * replace semantics fall out of content addressing) → the shared upload
 * pipeline (sniff, variants, files row) → gallery membership unless
 * `--assets-only` (files only) → the directory name becomes a tag
 * (normalized through the shared slug rules) → per-run report. Hard
 * failures exit non-zero.
 *
 * Deps are constructed here like media-audit / verify-media: the app's
 * `$env/dynamic` modules exist only inside the SvelteKit runtime.
 */

const SCAN_EXTENSIONS = new Set([
	'jpg',
	'jpeg',
	'png',
	'gif',
	'webp',
	'avif',
	'heic',
	'heif',
	'tif',
	'tiff',
	'pdf',
	'zip',
	'txt',
	'md'
]);

interface Options {
	dirs: string[];
	assetsOnly: boolean;
	concurrency: number;
}

function parseArgs(argv: string[]): Options {
	const dirs: string[] = [];
	let assetsOnly = false;
	let concurrency = 3;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === '--assets-only') {
			assetsOnly = true;
		} else if (arg === '--concurrency') {
			const value = argv[index + 1];
			// A flag missing its value used to swallow the NEXT flag as the
			// number (NaN → silent default) — reject loudly instead.
			if (value === undefined || value.startsWith('--')) {
				throw new Error('--concurrency requires a value (1-4)');
			}
			concurrency = Number(value);
			index += 1;
		} else if (arg.startsWith('--')) {
			throw new Error(`Unknown flag: ${arg}`);
		} else {
			dirs.push(arg);
		}
	}
	if (dirs.length === 0) {
		throw new Error('Usage: pnpm media:import <dir…> [--assets-only] [--concurrency 1-4]');
	}
	const clamped = Math.min(4, Math.max(1, Math.trunc(concurrency) || 3));
	return { dirs, assetsOnly, concurrency: clamped };
}

async function walk(root: string, out: string[]): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			await walk(path, out);
		} else if (entry.isFile()) {
			const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
			if (SCAN_EXTENSIONS.has(ext)) out.push(path);
		}
	}
}

/** Bounded-concurrency map; order of results matches the input order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await fn(items[index]!);
		}
	});
	await Promise.all(workers);
	return results;
}

type PhotoOutcome = 'off' | 'created' | 'already' | 'not-image' | 'unavailable';

/** Drizzle wraps driver errors; the operator needs the nested PG message too. */
function describeError(cause: unknown): string {
	if (!(cause instanceof Error)) return String(cause);
	const parts = [cause.message.split('\n')[0]!];
	const nested = (cause as { cause?: unknown }).cause;
	if (nested instanceof Error && nested.message) {
		parts.push(nested.message.split('\n')[0]!);
	}
	const text = parts.join(' — ');
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

interface Outcome {
	path: string;
	status: 'new' | 'deduplicated' | 'skipped' | 'failed';
	photo: PhotoOutcome;
	detail: string | null;
}

const options = parseArgs(process.argv.slice(2));
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 2 + options.concurrency });
const db = drizzle(sql, { schema });
const storage = new RustFsStorage(storageConfigFromEnv(process.env));

let scanned = 0;
let created = 0;
let deduplicated = 0;
let photosCreated = 0;
let photosAlready = 0;
let photosSkipped = 0;
let skipped = 0;
let failed = 0;

for (const dir of options.dirs) {
	const root = resolve(dir);
	const rootInfo = await stat(root).catch(() => null);
	if (!rootInfo?.isDirectory()) {
		console.error(`! not a directory: ${root}`);
		failed += 1;
		continue;
	}
	const tag = tagSlug(basename(root));
	const paths: string[] = [];
	await walk(root, paths);
	scanned += paths.length;
	console.log(`\nimporting ${paths.length} files from ${root}${tag ? `  (tag: ${tag})` : ''}`);

	const outcomes = await mapPool(paths, options.concurrency, async (path): Promise<Outcome> => {
		const fileName = basename(path);
		try {
			const info = await stat(path);
			if (info.size > MAX_UPLOAD_BYTES) {
				return { path, status: 'skipped', photo: 'off', detail: `too large (${info.size} bytes)` };
			}
			const bytes = await readFile(path);
			const uploaded = await uploadFile({ fileName, bytes }, { db, storage });
			if (uploaded.deduplicated) {
				deduplicated += 1;
				if (options.assetsOnly) {
					return { path, status: 'deduplicated', photo: 'off', detail: null };
				}
				// The file is known, the gallery row may not be: a rerun still
				// finishes half-done imports (photo kinds are counted by the
				// photo outcome, never by the file outcome).
				const photo = await createPhotoFromFile(
					uploaded.id,
					{ tags: tag ? [tag] : [] },
					{ db, storage }
				);
				switch (photo.kind) {
					case 'ok':
						photosCreated += 1;
						return {
							path,
							status: 'deduplicated',
							photo: 'created',
							detail: `/photos/${photo.slug}`
						};
					case 'already-in-gallery':
						photosAlready += 1;
						return { path, status: 'deduplicated', photo: 'already', detail: null };
					case 'not-image':
						photosSkipped += 1;
						return { path, status: 'deduplicated', photo: 'not-image', detail: null };
					default:
						photosSkipped += 1;
						return { path, status: 'deduplicated', photo: 'unavailable', detail: photo.kind };
				}
			}
			created += 1;
			if (options.assetsOnly) {
				return { path, status: 'new', photo: 'off', detail: null };
			}
			const photo = await createPhotoFromFile(
				uploaded.id,
				{ tags: tag ? [tag] : [] },
				{ db, storage }
			);
			switch (photo.kind) {
				case 'ok':
					photosCreated += 1;
					return { path, status: 'new', photo: 'created', detail: `/photos/${photo.slug}` };
				case 'already-in-gallery':
					photosAlready += 1;
					return { path, status: 'new', photo: 'already', detail: null };
				case 'not-image':
					photosSkipped += 1;
					return { path, status: 'new', photo: 'not-image', detail: null };
				default:
					photosSkipped += 1;
					return { path, status: 'new', photo: 'unavailable', detail: photo.kind };
			}
		} catch (cause) {
			if (cause instanceof UploadRejected) {
				return { path, status: 'skipped', photo: 'off', detail: cause.code };
			}
			return { path, status: 'failed', photo: 'off', detail: describeError(cause) };
		}
	});

	for (const outcome of outcomes) {
		if (outcome.status === 'failed') {
			failed += 1;
			console.log(`  ! ${basename(outcome.path)}: ${outcome.detail ?? 'unknown error'}`);
		} else if (outcome.status === 'skipped') {
			skipped += 1;
			console.log(`  - ${basename(outcome.path)}: ${outcome.detail ?? 'skipped'}`);
		} else if (outcome.photo === 'created') {
			console.log(`  + ${basename(outcome.path)} -> ${outcome.detail}`);
		}
	}
}

console.log('\nreport');
console.log(`  scanned:      ${scanned} files`);
console.log(`  files:        ${created} new · ${deduplicated} already in library`);
console.log(
	`  photos:       ${photosCreated} created · ${photosAlready} already in gallery · ${photosSkipped} skipped${
		options.assetsOnly ? ' (assets-only)' : ''
	}`
);
console.log(`  skipped:      ${skipped} (unsupported / too large)`);
console.log(`  failed:       ${failed}`);

await sql.end();
// exitCode (not process.exit) so libuv tears down naturally — process.exit
// racing open handles asserts on Windows (uv async.c) after a clean report.
process.exitCode = failed > 0 ? 1 : 0;

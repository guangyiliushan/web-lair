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

/**
 * Video containers are NOT yet whitelisted (server-side video is a future
 * item); Live Photo MOVs live here. They are scanned separately so they get
 * REPORTED as skipped instead of vanishing silently (multi-brand batch).
 */
const VIDEO_EXTENSIONS = new Set(['mov', 'mp4', 'm4v']);

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
			// number (NaN → silent default) — reject loudly instead
			// (round-2 review: non-integers must not fall back silently).
			if (value === undefined || value.startsWith('--')) {
				throw new Error('--concurrency requires a value (1-4)');
			}
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
				throw new Error(`--concurrency must be an integer between 1 and 4 (got "${value}")`);
			}
			concurrency = parsed;
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
	return { dirs, assetsOnly, concurrency };
}

interface WalkResult {
	paths: string[];
	videos: string[];
	/** Directories that could not be read (reported; counted as failures). */
	unreadable: string[];
	/** Symlinks skipped (round-2 review: never dropped silently). */
	symlinks: number;
	/** Files outside both whitelists, by extension. */
	ignored: Map<string, number>;
}

/** Recursive scan that never aborts the run: unreadable dirs are recorded. */
async function walk(root: string, acc: WalkResult): Promise<void> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
		acc.unreadable.push(`${root} (${code})`);
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			await walk(path, acc);
		} else if (entry.isFile()) {
			const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
			if (SCAN_EXTENSIONS.has(ext)) acc.paths.push(path);
			else if (VIDEO_EXTENSIONS.has(ext)) acc.videos.push(path);
			else {
				const key = ext === '' ? '(no extension)' : ext;
				acc.ignored.set(key, (acc.ignored.get(key) ?? 0) + 1);
			}
		} else if (entry.isSymbolicLink()) {
			acc.symlinks += 1;
		} else {
			acc.ignored.set('(non-regular)', (acc.ignored.get('(non-regular)') ?? 0) + 1);
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
let videoSkipped = 0;
let created = 0;
let deduplicated = 0;
let photosCreated = 0;
let photosAlready = 0;
let photosSkipped = 0;
let skipped = 0;
let failed = 0;
const unreadableDirs: string[] = [];
let ignoredFiles = 0;
let symlinkSkipped = 0;

for (const dir of options.dirs) {
	const root = resolve(dir);
	// Distinguish "missing / not a directory" from "cannot read it"
	// (round-2 review: EACCES used to masquerade as not-a-directory).
	const rootInfo = await stat(root).catch((error: NodeJS.ErrnoException) => error);
	if (rootInfo instanceof Error) {
		console.error(`! cannot read ${root}: ${rootInfo.code ?? rootInfo.name}`);
		failed += 1;
		continue;
	}
	if (!rootInfo.isDirectory()) {
		console.error(`! not a directory: ${root}`);
		failed += 1;
		continue;
	}
	const tag = tagSlug(basename(root));
	const walkResult: WalkResult = {
		paths: [],
		videos: [],
		unreadable: [],
		symlinks: 0,
		ignored: new Map()
	};
	await walk(root, walkResult);
	const paths = walkResult.paths;
	const videoPaths = walkResult.videos;
	scanned += paths.length;
	ignoredFiles += [...walkResult.ignored.values()].reduce((sum, count) => sum + count, 0);
	symlinkSkipped += walkResult.symlinks;
	unreadableDirs.push(...walkResult.unreadable);
	failed += walkResult.unreadable.length;
	console.log(`\nimporting ${paths.length} files from ${root}${tag ? `  (tag: ${tag})` : ''}`);
	if (walkResult.ignored.size > 0) {
		const top = [...walkResult.ignored.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([ext, count]) => `${ext}×${count}`)
			.join(', ');
		console.log(`  outside the whitelist (not imported): ${top}`);
	}
	if (walkResult.symlinks > 0) {
		console.log(`  symlinks skipped: ${walkResult.symlinks} (regular files only)`);
	}
	for (const broken of walkResult.unreadable) {
		console.error(`  ! unreadable directory: ${broken}`);
	}
	if (videoPaths.length > 0) {
		videoSkipped += videoPaths.length;
		console.log(
			`  video files SKIPPED (whitelist pending — Live Photo MOV / video): ${videoPaths.length}`
		);
		for (const video of videoPaths.slice(0, 5)) {
			console.log(`      ~ ${basename(video)}`);
		}
	}

	/**
	 * One counting rule for both upload branches (round-3 review: the switch
	 * had been duplicated once and its copy had already drifted).
	 */
	const enterGallery = async (
		path: string,
		fileId: string,
		status: 'new' | 'deduplicated'
	): Promise<Outcome> => {
		const photo = await createPhotoFromFile(fileId, { tags: tag ? [tag] : [] }, { db, storage });
		switch (photo.kind) {
			case 'ok':
				photosCreated += 1;
				return { path, status, photo: 'created', detail: `/photos/${photo.slug}` };
			case 'already-in-gallery':
				photosAlready += 1;
				return { path, status, photo: 'already', detail: null };
			case 'not-image':
				photosSkipped += 1;
				return { path, status, photo: 'not-image', detail: null };
			default:
				photosSkipped += 1;
				return { path, status, photo: 'unavailable', detail: photo.kind };
		}
	};

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
			} else {
				created += 1;
			}
			const status = uploaded.deduplicated ? 'deduplicated' : 'new';
			if (options.assetsOnly) {
				return { path, status, photo: 'off', detail: null };
			}
			// The file is known, the gallery row may not be: a rerun still
			// finishes half-done imports (photo kinds are counted by the
			// photo outcome, never by the file outcome).
			return enterGallery(path, uploaded.id, status);
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
if (videoSkipped > 0) {
	console.log(`  video:        ${videoSkipped} file(s) reported skipped (whitelist pending)`);
}
if (ignoredFiles > 0) {
	console.log(`  ignored:      ${ignoredFiles} outside the whitelist`);
}
if (symlinkSkipped > 0) {
	console.log(`  symlinks:     ${symlinkSkipped} skipped`);
}
if (unreadableDirs.length > 0) {
	console.log(`  unreadable:   ${unreadableDirs.length} director(ies) — see the ! lines`);
}
console.log(`  failed:       ${failed}`);

await sql.end();
// exitCode (not process.exit) so libuv tears down naturally — process.exit
// racing open handles asserts on Windows (uv async.c) after a clean report.
process.exitCode = failed > 0 ? 1 : 0;

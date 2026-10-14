import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { drafts, notes, pages, posts } from '../src/lib/server/db/content';
import { files } from '../src/lib/server/db/content/file.schema';
import { fileReferences } from '../src/lib/server/db/system';
import {
	keysFromContent,
	keysFromLocalizedContent,
	syncFileReferences,
	type RefsExecutor
} from '../src/lib/server/services/file-references';

/**
 * Reference backfill (ST-3 3b2; Q17): reconciles `file_references` with the
 * `/i/<key>` keys mentioned by the four content sources. Dry-run by default -
 * it reports the per-entity diff and writes NOTHING; `--apply` runs each
 * entity's diff through `syncFileReferences` in its own transaction, so the
 * flip matrix and the locking discipline are exactly the write-side ones.
 * Idempotent: a second run finds nothing. Expected first run on the dev
 * database: 0 additions (no existing content carries `/i/` keys) - the value
 * is the audit baseline and the dry-run practice.
 *
 * Run: pnpm db:backfill-refs  (add --apply to write)
 */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env).');
	process.exit(1);
}
const apply = process.argv.includes('--apply');

const sql = postgres(DATABASE_URL, { max: 2 });
const db = drizzle(sql, { schema });

interface BackfillEntity {
	refType: 'post' | 'note' | 'page' | 'draft';
	refId: string;
	label: string;
	keys: string[];
}

async function loadEntities(): Promise<BackfillEntity[]> {
	const entities: BackfillEntity[] = [];
	const postRows = await db
		.select({ id: posts.id, title: posts.title, content: posts.content })
		.from(posts);
	for (const row of postRows) {
		entities.push({
			refType: 'post',
			refId: row.id,
			label: `post ${JSON.stringify(row.title).slice(0, 60)}`,
			keys: keysFromContent(row.content)
		});
	}
	const noteRows = await db
		.select({ id: notes.id, title: notes.title, content: notes.content })
		.from(notes);
	for (const row of noteRows) {
		entities.push({
			refType: 'note',
			refId: row.id,
			label: `note ${JSON.stringify(row.title).slice(0, 60)}`,
			keys: keysFromContent(row.content)
		});
	}
	const pageRows = await db
		.select({ id: pages.id, slug: pages.slug, content: pages.content })
		.from(pages);
	for (const row of pageRows) {
		entities.push({
			refType: 'page',
			refId: row.id,
			label: `page ${row.slug}`,
			keys: keysFromLocalizedContent(row.content as Record<string, unknown> | null)
		});
	}
	const draftRows = await db
		.select({ id: drafts.id, title: drafts.title, content: drafts.content })
		.from(drafts);
	for (const row of draftRows) {
		entities.push({
			refType: 'draft',
			refId: row.id,
			label: `draft ${JSON.stringify(row.title).slice(0, 60)}`,
			keys: keysFromContent(row.content)
		});
	}

	// Only entities that MENTION keys are interesting; a full drift report of
	// removals is the audit's check ④, not the backfill's job.
	return entities.filter((entity) => entity.keys.length > 0);
}

async function existingKeys(executor: RefsExecutor, entity: BackfillEntity): Promise<Set<string>> {
	const rows = await executor
		.select({ objectKey: files.objectKey })
		.from(fileReferences)
		.innerJoin(files, eq(fileReferences.fileId, files.id))
		.where(and(eq(fileReferences.refType, entity.refType), eq(fileReferences.refId, entity.refId)));
	return new Set(rows.map((row) => row.objectKey));
}

const entities = await loadEntities();
const totalKeys = entities.reduce((sum, entity) => sum + entity.keys.length, 0);
console.log(
	`backfill-file-references @ ${new Date().toISOString()} (${apply ? 'APPLY' : 'dry-run'})`
);
console.log(`  entities with mentions: ${entities.length}, distinct mentions: ${totalKeys}`);

// Registry coverage: a mentioned key without a files row can never be written
// (sync skips + warns); surface it here so the report is self-contained.
const registryRows = await db.select({ objectKey: files.objectKey }).from(files);
const registry = new Set(registryRows.map((row) => row.objectKey));

let plannedAdds = 0;
let plannedRemoves = 0;
let missingTotal = 0;
let applied = 0;

for (const entity of entities) {
	const existing = await existingKeys(db, entity);
	const desired = new Set(entity.keys);
	const adds = [...desired].filter((key) => !existing.has(key));
	const removes = [...existing].filter((key) => !desired.has(key));
	// A mention without a registry row can never be written (sync skips and
	// warns): keep it out of the plan so the second run reports a true zero.
	const missing = adds.filter((key) => !registry.has(key));
	const writableAdds = adds.filter((key) => registry.has(key));
	missingTotal += missing.length;
	if (writableAdds.length === 0 && removes.length === 0) {
		if (missing.length > 0) {
			console.log(
				`  ${entity.refType} ${entity.refId}  missing-only [${entity.label}]: ${missing.join(', ')}`
			);
		}
		continue;
	}
	plannedAdds += writableAdds.length;
	plannedRemoves += removes.length;
	const suffix = missing.length > 0 ? ` (missing registry: ${missing.join(', ')})` : '';
	console.log(
		`  ${entity.refType} ${entity.refId}  +${writableAdds.length} -${removes.length}  [${entity.label}]${suffix}`
	);
	if (apply) {
		await db.transaction(async (tx) =>
			syncFileReferences(tx, { type: entity.refType, id: entity.refId }, entity.keys)
		);
		applied += 1;
	}
}

console.log(
	`  planned: +${plannedAdds} refs, -${plannedRemoves} refs across ${applied || entities.length} entities (missing registry mentions: ${missingTotal})`
);
if (!apply && (plannedAdds > 0 || plannedRemoves > 0)) {
	console.log('  dry-run only - re-run with --apply to write.');
}
if (plannedAdds === 0 && plannedRemoves === 0) {
	console.log('  nothing to do (idempotent baseline).');
}

await sql.end();
process.exit(0);

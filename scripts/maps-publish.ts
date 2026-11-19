import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/lib/server/db/schema';
import { activeStorage } from './lib/active-storage';

/**
 * Publish a local PMTiles archive into the `maps/` prefix: the
 * serve route `/maps/<file>.pmtiles` reads exactly this key space and the
 * extract is built with the go-pmtiles CLI, never the
 * rotating public builds. Usage: `pnpm ops maps publish <local-file>
 * [<remote-name>]`.
 */
const [file, remoteArg] = process.argv.slice(2);
if (!file) {
	console.error('Usage: pnpm ops maps publish <local-file> [<remote-name>]');
	process.exit(1);
}
const name = remoteArg ?? basename(file);
// Case-SENSITIVE on purpose: the serve route's name check
// has no /i, so a mixed-case name would publish but never serve.
if (!/^[a-z0-9][a-z0-9._-]*\.pmtiles$/.test(name)) {
	console.error(`Invalid remote name: ${name} (expect <safe>.pmtiles)`);
	process.exit(1);
}
const bytes = await readFile(file);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('DATABASE_URL is required (use --env-file=.env) to resolve the active provider.');
	process.exit(1);
}
const sql = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(sql, { schema });
// Tiles follow the ACTIVE provider, the same one /maps reads.
const storage = await activeStorage(db);
await storage.ensureBucket();
const { etag } = await storage.put(`maps/${name}`, new Uint8Array(bytes), {
	contentType: 'application/vnd.pmtiles'
});
const head = await storage.head(`maps/${name}`);
console.log(
	`published maps/${name}: ${bytes.byteLength} bytes, etag=${etag}, head.size=${head?.byteSize}, type=${head?.contentType}`
);
process.exitCode = 0;
await sql.end();

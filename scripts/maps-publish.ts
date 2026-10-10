import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';

/**
 * Publish a local PMTiles archive into the `maps/` prefix (plan §8): the
 * serve route `/maps/<file>.pmtiles` reads exactly this key space and the
 * extract is built with the pinned go-pmtiles CLI (v1.31.2), never the
 * rotating public builds. Usage: `pnpm maps:publish <local-file>
 * [<remote-name>]`.
 */
const [file, remoteArg] = process.argv.slice(2);
if (!file) {
	console.error('Usage: pnpm maps:publish <local-file> [<remote-name>]');
	process.exit(1);
}
const name = remoteArg ?? basename(file);
// Case-SENSITIVE on purpose (round-3 review): the serve route's name check
// has no /i, so a mixed-case name would publish but never serve.
if (!/^[a-z0-9][a-z0-9._-]*\.pmtiles$/.test(name)) {
	console.error(`Invalid remote name: ${name} (expect <safe>.pmtiles)`);
	process.exit(1);
}
const bytes = await readFile(file);
const storage = new RustFsStorage(storageConfigFromEnv(process.env));
await storage.ensureBucket();
const { etag } = await storage.put(`maps/${name}`, new Uint8Array(bytes), {
	contentType: 'application/vnd.pmtiles'
});
const head = await storage.head(`maps/${name}`);
console.log(
	`published maps/${name}: ${bytes.byteLength} bytes, etag=${etag}, head.size=${head?.byteSize}, type=${head?.contentType}`
);
process.exitCode = 0;

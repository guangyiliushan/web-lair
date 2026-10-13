import sharp from 'sharp';
import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';

/**
 * Fixture bytes for e2e/photos-viewer-overlay.e2e.ts (ST-3 3c-4). Those
 * registry rows are seeded by the spec itself; the object bytes cannot be
 * (the spec process has no storage client), so this idempotent script
 * publishes three small GIFs to RustFS. GIF = single object, no variant
 * tiers, so one key serves both the page thumb and the overlay "full" fetch;
 * the keys satisfy KEY_PATTERN's directory backreference. Re-run after a
 * bucket wipe:
 *
 *   pnpm exec tsx --env-file=.env scripts/e2e-overlay-fixtures.ts
 */
const TARGETS = [
	{ key: `ab/ab${'1'.repeat(62)}.gif`, shade: 0 },
	{ key: `ab/ab${'2'.repeat(62)}.gif`, shade: 1 },
	{ key: `ab/ab${'3'.repeat(62)}.gif`, shade: 2 }
];

async function main(): Promise<void> {
	const storage = new RustFsStorage(storageConfigFromEnv(process.env));
	await storage.ensureBucket();
	for (const target of TARGETS) {
		const bytes = await sharp({
			create: {
				width: 800,
				height: 600,
				channels: 3,
				background: { r: 60 + target.shade * 60, g: 120 - target.shade * 30, b: 180 }
			}
		})
			.gif()
			.toBuffer();
		const { etag } = await storage.put(target.key, new Uint8Array(bytes), {
			contentType: 'image/gif'
		});
		const head = await storage.head(target.key);
		console.log(
			`put ${target.key} (${bytes.byteLength} B, etag=${etag ?? 'n/a'}, head=${head?.byteSize} B)`
		);
	}
	console.log('overlay e2e fixture bytes ready.');
}

await main();

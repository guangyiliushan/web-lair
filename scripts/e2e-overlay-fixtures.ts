import sharp from 'sharp';
import { OVERLAY_FIXTURE_DIMENSIONS, OVERLAY_FIXTURE_KEYS } from '../e2e/overlay-fixture-keys';
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
 *   pnpm e2e:overlay-fixtures
 * (or: pnpm exec tsx --env-file=.env scripts/e2e-overlay-fixtures.ts)
 */
const TARGETS = Object.values(OVERLAY_FIXTURE_KEYS);
const BACKGROUND = { r: 72, g: 96, b: 160 };

async function main(): Promise<void> {
	const storage = new RustFsStorage(storageConfigFromEnv(process.env));
	await storage.ensureBucket();
	for (const key of TARGETS) {
		const bytes = await sharp({
			create: {
				width: OVERLAY_FIXTURE_DIMENSIONS.width,
				height: OVERLAY_FIXTURE_DIMENSIONS.height,
				channels: 3,
				background: BACKGROUND
			}
		})
			.gif()
			.toBuffer();
		const { etag } = await storage.put(key, new Uint8Array(bytes), {
			contentType: 'image/gif'
		});
		const head = await storage.head(key);
		console.log(
			`put ${key} (${bytes.byteLength} B, etag=${etag ?? 'n/a'}, head=${head?.byteSize} B)`
		);
	}
	console.log('overlay e2e fixture bytes ready.');
}

await main();

import { storageConfigFromEnv } from '../src/lib/server/storage/config';
import { RustFsStorage } from '../src/lib/server/storage/rustfs';

/**
 * ST-1 infra smoke (ledger §21): ensures the bucket exists and exercises the
 * tested S3 subset — PUT / GET / HEAD / DELETE — against the local RustFS
 * container. Run with: `pnpm storage:smoke` (tsx --env-file=.env).
 */
async function main(): Promise<void> {
	const config = storageConfigFromEnv(process.env);
	const storage = new RustFsStorage(config);
	const probeKey = `smoke/probe-${Date.now().toString(36)}.txt`;
	const payloadText = `web-lair storage smoke ${new Date().toISOString()}\n`;
	const payload = new TextEncoder().encode(payloadText);

	await storage.ensureBucket();
	console.log(`ok  ensureBucket (${config.endpoint}, bucket=${config.bucket})`);

	const { etag } = await storage.put(probeKey, payload, {
		contentType: 'text/plain; charset=utf-8'
	});
	console.log(`ok  put ${probeKey} (${payload.byteLength} B, etag=${etag ?? 'n/a'})`);

	const head = await storage.head(probeKey);
	if (!head || head.byteSize !== payload.byteLength) {
		throw new Error(`head mismatch: ${JSON.stringify(head)}`);
	}
	console.log(`ok  head (byteSize=${head.byteSize}, contentType=${head.contentType})`);

	const got = await storage.get(probeKey);
	if (!got) throw new Error('get returned null');
	const roundtrip = await new Response(got.body).text();
	if (roundtrip !== payloadText) {
		throw new Error(`get payload mismatch: ${JSON.stringify(roundtrip)}`);
	}
	console.log(`ok  get (roundtrip ${roundtrip.length} chars)`);

	await storage.delete(probeKey);
	const after = await storage.head(probeKey);
	if (after !== null) throw new Error('object still present after delete');
	console.log('ok  delete (probe object removed; head -> null)');

	console.log('\nALL storage smoke checks passed.');
}

await main();

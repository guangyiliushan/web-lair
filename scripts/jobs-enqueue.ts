// scripts/jobs-enqueue.ts
//
// Manual trigger CLI : queues a run and returns
// immediately; the next drain tick (<= 60s with the platform timer) executes
// it. This is the operator surface for manual runs until the admin page
// lands. It records `trigger='cli'` to tell the two apart in the ledger.
// The name set is registry ∪ user layer, so user job scripts can be
// queued the same way.
//
//   pnpm ops jobs enqueue <job-name>

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { resolveDataDir } from '../src/lib/server/jobs/data-dir.ts';
import { enqueueJob } from '../src/lib/server/jobs/queue.ts';
import { JOBS } from '../src/lib/server/jobs/registry.ts';
import { resolveJobDefinition } from '../src/lib/server/jobs/user-layer.ts';

const name = process.argv[2];
if (!name) {
	console.error('usage: pnpm ops jobs enqueue <job-name>');
	console.error(`registered jobs: ${Object.keys(JOBS).join(', ')}`);
	process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('✗ DATABASE_URL is required (run via `pnpm ops jobs enqueue`).');
	process.exit(1);
}

const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const db = drizzle(client);
try {
	const definition = await resolveJobDefinition(name, resolveDataDir());
	if (!definition) throw new Error(`unknown job "${name}"`);
	const result = await enqueueJob(db, name, 'cli', definition);
	console.log(
		result.deduplicated
			? `job "${name}" already queued (run ${result.id}); the next drain tick will execute it.`
			: `job "${name}" queued (run ${result.id}); the next drain tick will execute it.`
	);
} catch (err) {
	console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
} finally {
	await client.end({ timeout: 5 });
}

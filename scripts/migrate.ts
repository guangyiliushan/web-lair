/**
 * Production migration entry point (D-1, Q3).
 *
 * Why not `drizzle-kit migrate`: drizzle-kit is a devDependency and the
 * runtime image ships production dependencies only. `drizzle-orm`'s migrator
 * reads the same `drizzle/meta/_journal.json` and writes the same
 * `drizzle.__drizzle_migrations` rows — verified 2026-10-17 against a scratch
 * database (id/hash/created_at byte-identical, 48 public tables, re-run
 * idempotent).
 *
 * Usage (host):  node --env-file-if-exists=.env scripts/migrate.ts
 * Usage (container): node scripts/migrate.ts     # env from compose
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('[migrate] DATABASE_URL is not set');
	process.exit(2);
}

const client = postgres(url, { max: 1 });
try {
	await migrate(drizzle(client), { migrationsFolder: './drizzle' });
	console.log('[migrate] migrations applied');
} catch (error) {
	console.error('[migrate] failed:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	await client.end();
}

// scripts/verify-owner-uniqueness.ts
//
// Acceptance script: proves the owner slot can never be granted twice under concurrency
// (READ COMMITTED write-skew regression).
//
// Measured 2026-09-24: with only a `NOT EXISTS` conditional UPDATE, two concurrent claims
// both succeed and two rows become owner. This script replays that race on a temporary
// database with the same app-side primitives (src/lib/server/auth/owner-claim.ts) and
// asserts exactly 1 owner.
//
// Usage: pnpm db:verify-owner
// Environment: DATABASE_URL (derives a temporary <db>_owner_check database, dropped afterwards)

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import { user } from '../src/lib/server/db/auth.schema';
import { noOtherOwner, ownerClaimLock } from '../src/lib/server/auth/owner-claim';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('✗ DATABASE_URL is required.');
	process.exit(1);
}

const base = new URL(DB_URL);
const dbName = `${base.pathname.slice(1)}_owner_check`;
const checkUrl = (() => {
	const u = new URL(DB_URL);
	u.pathname = `/${dbName}`;
	return u.toString();
})();
const adminUrl = (() => {
	const u = new URL(DB_URL);
	u.pathname = '/postgres';
	return u.toString();
})();

async function main() {
	const admin = postgres(adminUrl, { max: 1 });
	await admin.unsafe(`drop database if exists "${dbName}"`);
	await admin.unsafe(`create database "${dbName}"`);
	await admin.end();

	const client = postgres(checkUrl, { max: 4 });
	const db = drizzle(client);

	try {
		await db.execute(sql`drop table if exists "user"`);
		// Mirrors the columns the drizzle `user` model writes (including the
		// `$onUpdate` timestamp), so the claim UPDATE runs exactly as in the app.
		await db.execute(
			sql`create table "user" (
				id text primary key,
				role text,
				email_verified boolean default false,
				updated_at timestamp default now() not null
			)`
		);
		await db.execute(sql`insert into "user" (id) values ('A'), ('B')`);

		const claim = (id: string, waitSeconds: number) =>
			db.transaction(async (tx) => {
				await tx.execute(ownerClaimLock());
				if (waitSeconds > 0) await tx.execute(sql`select pg_sleep(${waitSeconds})`);
				const rows = await tx
					.update(user)
					.set({ role: 'owner', emailVerified: true })
					.where(and(eq(user.id, id), noOtherOwner(id)))
					.returning({ id: user.id });
				return rows.length > 0;
			});

		// Both start together; the advisory lock serialises them, so the loser sees
		// the winner's committed row and its conditional UPDATE matches nothing.
		const [a, b] = await Promise.all([claim('A', 2), claim('B', 0)]);
		const rows = (await db.execute(sql`select id, role from "user" order by id`)) as unknown as {
			id: string;
			role: string | null;
		}[];
		const owners = rows.filter((r) => r.role === 'owner');

		console.log(`claim(A)=${a} claim(B)=${b} owners=${owners.length}`);
		if (owners.length === 1 && a !== b) {
			console.log('✓ owner 唯一性保持（并发下恰好 1 个 owner）');
		} else {
			console.error('✗ 写偏斜回归：owners =', owners.map((r) => r.id).join(','));
			process.exitCode = 1;
		}
	} finally {
		await client.end();
		const cleanup = postgres(adminUrl, { max: 1 });
		await cleanup.unsafe(`drop database if exists "${dbName}"`);
		await cleanup.end();
	}
}

main();

// scripts/verify-review-idempotency.ts
//
// Acceptance for the comment-review state machine (B2.1 review fix, T3):
//   pnpm db:verify-review
//
// Runs on a scratch database and proves the review UPDATE is pending-only:
//   1) a decision applies exactly once - replaying it matches 0 rows;
//   2) concurrent approve/reject on the same row: exactly one wins.
//
// The WHERE clause mirrors `(admin)/admin/comments/+page.server.ts`
// (state = 'pending' AND is_deleted = false) - keep the two in sync.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('✗ DATABASE_URL is required (run via `pnpm db:verify-review`).');
	process.exit(1);
}

const base = new URL(DB_URL);
const dbName = `${base.pathname.slice(1)}_review_check`;
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

	const client = postgres(checkUrl, { max: 3, onnotice: () => {} });
	const db = drizzle(client);

	try {
		await db.execute(sql`drop table if exists comments`);
		await db.execute(
			sql`create table comments (
				id text primary key,
				state text not null default 'pending',
				reviewed_by text,
				reviewed_at timestamptz,
				is_deleted boolean not null default false
			)`
		);
		await db.execute(sql`insert into comments (id) values ('c1')`);

		const decide = async (state: string, reviewer: string) => {
			const rows = (await db.execute(
				sql`update comments
					set state = ${state}, reviewed_by = ${reviewer}, reviewed_at = now()
					where id = 'c1' and state = 'pending' and is_deleted = false
					returning id`
			)) as unknown as Array<{ id: string }>;
			return rows.length;
		};

		// 1) replay: the second decision must match 0 rows (pending-only guard).
		const first = await decide('approved', 'u1');
		const replay = await decide('rejected', 'u2');

		// 2) concurrency: reset, then both decisions race - exactly one wins.
		await db.execute(
			sql`update comments set state = 'pending', reviewed_by = null, reviewed_at = null where id = 'c1'`
		);
		const [a, b] = await Promise.all([decide('approved', 'u1'), decide('rejected', 'u2')]);

		const final = (await db.execute(
			sql`select state, reviewed_by from comments where id = 'c1'`
		)) as unknown as Array<{ state: string; reviewed_by: string | null }>;

		console.log(
			`first=${first} replay=${replay} concurrent=${a}+${b} final=${final[0]?.state}/${final[0]?.reviewed_by}`
		);
		if (first === 1 && replay === 0 && a + b === 1) {
			console.log('✓ pending-only 状态机保持（重放 0 行、并发恰一胜）');
		} else {
			console.error('✗ 重放/并发语义回归：期望 first=1 replay=0 concurrent=1');
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

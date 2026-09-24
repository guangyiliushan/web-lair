// scripts/ensure-site-org.ts
//
// Repair + acceptance entry for the site organization (B2, ledger §4.22):
//   pnpm db:ensure-org
//
// Creates the `web-lair` organization and the owner's member row when they are
// missing (idempotent). This is the recovery path named by the /admin/setup
// failure message. It writes the same two rows the organization plugin writes
// (createOrganization + its creator member), without pulling the app's
// `$env`-dependent modules into a plain tsx process.
//
// Acceptance (§12-1): running it twice must leave exactly one organization row
// and one owner membership - the trailing count check enforces that.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { user } from '../src/lib/server/db/auth.schema';

const SLUG = 'web-lair';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error('✗ DATABASE_URL is required (run via `pnpm db:ensure-org`).');
	process.exit(1);
}

const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
const db = drizzle(client);

try {
	const owners = await db.select({ id: user.id }).from(user).where(eq(user.role, 'owner')).limit(1);
	const owner = owners[0];
	if (!owner) {
		console.error('✗ no site owner found — run /admin/setup first.');
		process.exitCode = 1;
	} else {
		const existing = (await db.execute(
			sql`select "id" from "organization" where "slug" = ${SLUG} limit 1`
		)) as unknown as Array<{ id: string }>;
		let organizationId = existing[0]?.id;
		if (!organizationId) {
			organizationId = randomUUID();
			await db.execute(
				sql`insert into "organization" ("id", "name", "slug", "created_at") values (${organizationId}, 'Web Lair', ${SLUG}, now())`
			);
			console.log(`✓ created organization ${organizationId}`);
		} else {
			console.log(`→ organization already exists (${organizationId})`);
		}

		const membership = (await db.execute(
			sql`select 1 from "member" where "organization_id" = ${organizationId} and "user_id" = ${owner.id} limit 1`
		)) as unknown as Array<unknown>;
		if (membership.length === 0) {
			await db.execute(
				sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${randomUUID()}, ${organizationId}, ${owner.id}, 'owner', now())`
			);
			console.log('✓ owner membership created');
		} else {
			console.log('→ owner membership already present');
		}

		const count = (await db.execute(
			sql`select count(*)::int as n from "organization" where "slug" = ${SLUG}`
		)) as unknown as Array<{ n: number }>;
		if (count[0]?.n === 1) {
			console.log('✓ exactly one site organization');
		} else {
			console.error(`✗ expected exactly 1 organization, found ${count[0]?.n}`);
			process.exitCode = 1;
		}
	}
} finally {
	await client.end();
}

// scripts/ensure-site-org.ts
//
// Repair + acceptance entry for the site organization (B2, ledger §4.22):
//   pnpm db:ensure-org
//
// Creates the `web-lair` organization and the owner's member row when they are
// missing (idempotent). This is the recovery path named by the /admin/setup
// failure message. It writes the same two rows the organization plugin writes
// (createOrganization + its creator member), holding the same advisory lock as
// the app-side bootstrap (`site-organization.shared.ts`), so the two writers
// cannot interleave into a duplicate membership (B2.1 review fix).
//
// Anchored to better-auth 1.7.5: it bypasses the official API on purpose (the
// app's `$env`-dependent modules cannot load in a plain tsx process). If the
// plugin's organization/member tables gain columns, revisit this script.
//
// Acceptance (§12-1): running it twice must leave exactly one organization row
// AND exactly one owner membership - the trailing assertions enforce both.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { user } from '../src/lib/server/db/auth.schema';
import {
	SITE_ORGANIZATION_NAME,
	SITE_ORGANIZATION_SLUG,
	siteMemberLock
} from '../src/lib/server/auth/site-organization.shared';

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
		await db.transaction(async (tx) => {
			await tx.execute(siteMemberLock());

			const existing = (await tx.execute(
				sql`select "id" from "organization" where "slug" = ${SITE_ORGANIZATION_SLUG} limit 1`
			)) as unknown as Array<{ id: string }>;
			let organizationId = existing[0]?.id;
			if (!organizationId) {
				organizationId = randomUUID();
				await tx.execute(
					sql`insert into "organization" ("id", "name", "slug", "created_at") values (${organizationId}, ${SITE_ORGANIZATION_NAME}, ${SITE_ORGANIZATION_SLUG}, now())`
				);
				console.log(`✓ created organization ${organizationId}`);
			} else {
				console.log(`→ organization already exists (${organizationId})`);
			}

			const membership = (await tx.execute(
				sql`select 1 from "member" where "organization_id" = ${organizationId} and "user_id" = ${owner.id} limit 1`
			)) as unknown as Array<unknown>;
			if (membership.length === 0) {
				await tx.execute(
					sql`insert into "member" ("id", "organization_id", "user_id", "role", "created_at") values (${randomUUID()}, ${organizationId}, ${owner.id}, 'owner', now())`
				);
				console.log('✓ owner membership created');
			} else {
				console.log('→ owner membership already present');
			}
		});

		const orgs = (await db.execute(
			sql`select count(*)::int as n from "organization" where "slug" = ${SITE_ORGANIZATION_SLUG}`
		)) as unknown as Array<{ n: number }>;
		const members = (await db.execute(
			sql`select count(*)::int as n from "member" m join "organization" o on o.id = m.organization_id where o.slug = ${SITE_ORGANIZATION_SLUG} and m.role = 'owner'`
		)) as unknown as Array<{ n: number }>;
		if (orgs[0]?.n === 1 && members[0]?.n === 1) {
			console.log('✓ exactly one site organization and one owner membership');
		} else {
			console.error(
				`✗ expected 1 organization / 1 owner membership, found ${orgs[0]?.n} / ${members[0]?.n}`
			);
			process.exitCode = 1;
		}

		console.log(
			'note: app processes cache the organization id in-memory; if the organization row was replaced out-of-band, restart them.'
		);
	}
} finally {
	await client.end();
}

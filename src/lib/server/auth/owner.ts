import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';

export type AdminRole = 'owner' | 'admin';

export function isAdminRole(value: unknown): value is AdminRole {
	return value === 'owner' || value === 'admin';
}

/**
 * The site owner. There is exactly one by application-layer convention
 * (ledger §4.14): better-auth's admin plugin has no uniqueness constraint and
 * the generated `user` table must not carry a partial unique index.
 */
export async function findSiteOwner() {
	return db.query.user.findFirst({ where: eq(user.role, 'owner') });
}

/** Bootstrap guard shared by /admin/setup, the login page and the seed script. */
export async function hasAnyAdminAccount(): Promise<boolean> {
	const rows = await db
		.select({ id: user.id })
		.from(user)
		.where(inArray(user.role, ['owner', 'admin']))
		.limit(1);
	return rows.length > 0;
}

/**
 * Claims the owner slot atomically: the UPDATE only matches while no *other*
 * row is already owner, so two concurrent bootstraps cannot both win.
 */
export async function claimOwnerRole(userId: string): Promise<boolean> {
	const rows = await db
		.update(user)
		.set({ role: 'owner', emailVerified: true })
		.where(
			and(
				eq(user.id, userId),
				sql`not exists (select 1 from "user" as owner_row where owner_row.role = 'owner' and owner_row.id <> ${user.id})`
			)
		)
		.returning({ id: user.id });
	return rows.length > 0;
}

/** Direct role grant (seeding, tests). Prefer claimOwnerRole for the owner slot. */
export async function grantAdminRole(userId: string, role: AdminRole): Promise<void> {
	await db.update(user).set({ role, emailVerified: true }).where(eq(user.id, userId));
}

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { noOtherOwner, ownerClaimLock } from './owner-claim';

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
 * Claims the owner slot. The advisory lock serialises concurrent claims (two
 * bootstraps at once cannot both win); the conditional UPDATE keeps a repeated
 * call idempotent for the caller's own row. Both pieces live in `owner-claim.ts`
 * and are shared with `scripts/seed-owner.ts` so the two entry points cannot
 * drift apart.
 */
export async function claimOwnerRole(userId: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		await tx.execute(ownerClaimLock());
		const rows = await tx
			.update(user)
			.set({ role: 'owner', emailVerified: true })
			.where(and(eq(user.id, userId), noOtherOwner(userId)))
			.returning({ id: user.id });
		return rows.length > 0;
	});
}

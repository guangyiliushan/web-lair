import { and, eq } from 'drizzle-orm';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { member } from '$lib/server/db/auth.schema';
import { getSiteOrganizationId, invalidateSiteOrganizationCache } from './site-organization';
import {
	SITE_ORGANIZATION_NAME,
	SITE_ORGANIZATION_SLUG,
	siteMemberLock
} from './site-organization.shared';

/**
 * Idempotently bootstrap the single site organization, right after the owner
 * is claimed in /admin/setup. It uses the official system path of
 * `POST /organization/create`: called with `body.userId` and no session, the
 * endpoint skips `allowUserToCreateOrganization: false` by design
 * (`isSystemAction`, verified against better-auth 1.7.5 crud-org.mjs); that
 * path is server-only, because an HTTP caller always has a request, which the
 * endpoint rejects when no session is present. `creatorRole: 'owner'`
 * (auth.ts) makes the creator a member with `member.role = 'owner'`.
 * Failure is thrown to the caller: without the organization every
 * `hasPermission()` call would deny the owner, so the wizard must show an
 * explicit error instead of silently continuing.
 */
export async function ensureSiteOrganization(ownerUserId: string): Promise<string> {
	const existing = await getSiteOrganizationId();
	if (existing) {
		await ensureOwnerMembership(existing, ownerUserId);
		return existing;
	}

	const created = await auth.api.createOrganization({
		body: { name: SITE_ORGANIZATION_NAME, slug: SITE_ORGANIZATION_SLUG, userId: ownerUserId }
	});
	invalidateSiteOrganizationCache();
	await ensureOwnerMembership(created.id, ownerUserId);
	return created.id;
}

/**
 * Repair path: the organization exists but the owner has no member row (a
 * crash between the two writes of a previous bootstrap). `addMember` is
 * another server-only endpoint (registered without an HTTP path), so this
 * cannot be driven from outside the process.
 *
 * The generated `member` table cannot carry our unique index,
 * so "exactly one owner membership" is enforced by the same advisory lock
 * that the repair script takes.
 */
async function ensureOwnerMembership(organizationId: string, userId: string) {
	await db.transaction(async (tx) => {
		await tx.execute(siteMemberLock());
		const rows = await tx
			.select({ id: member.id })
			.from(member)
			.where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
			.limit(1);
		if (rows.length > 0) return;
		await auth.api.addMember({
			body: { userId, organizationId, role: 'owner' }
		});
	});
}

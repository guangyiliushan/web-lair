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
 * Idempotently bootstrap the single site organization (ledger §4.22, B2).
 *
 * Runs inside /admin/setup right after the owner is claimed. Uses the official
 * system path of `POST /organization/create`: called without a session but with
 * `body.userId`, the endpoint skips `allowUserToCreateOrganization: false` by
 * design (`isSystemAction`, verified against better-auth 1.7.5 crud-org.mjs).
 * That system path is server-only - an HTTP caller always has a request, which
 * the endpoint rejects when no session is present. `creatorRole: 'owner'`
 * (auth.ts) makes the creator a member with `member.role = 'owner'`.
 *
 * Failure is thrown to the caller: without the organization every
 * `hasPermission()` call would deny the owner, so the wizard must show an
 * explicit error instead of silently continuing (ledger §4.22).
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
 * The generated `member` table cannot carry our unique index (ledger §4.7),
 * so "exactly one owner membership" is enforced at the explicit-lock tier of
 * §12-1: the same advisory lock the repair script takes (B2.1 review fix).
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

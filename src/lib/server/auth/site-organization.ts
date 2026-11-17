import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { SITE_ORGANIZATION_SLUG } from './site-organization.shared';

/**
 * The single site organization: every session is fixed to it by the
 * `session.create.before` hook in `auth.ts`, so this lookup sits on the
 * session-creation path — the id is cached for the process lifetime and
 * `site-organization-bootstrap.ts` calls `invalidateSiteOrganizationCache()`
 * right after creation, so a long-lived dev server picks it up without a
 * restart.
 * Raw SQL on purpose: `auth.ts` imports this module, and a named import of
 * the generated `auth.schema.ts` would make the schema generator itself
 * impossible to run (the plugin's tables do not exist until it has run).
 * Table `organization` is the plugin default, columns are the generator's
 * snake_case; slug/name constants live in `site-organization.shared.ts`
 * (zero-dependency: the repair script imports them from a plain tsx process).
 */
let cachedId: string | null = null;

export async function getSiteOrganizationId(): Promise<string | null> {
	if (cachedId) return cachedId;
	const rows = (await db.execute(
		sql`select "id" from "organization" where "slug" = ${SITE_ORGANIZATION_SLUG} limit 1`
	)) as unknown as Array<{ id: string }>;
	cachedId = rows[0]?.id ?? null;
	return cachedId;
}

export function invalidateSiteOrganizationCache() {
	cachedId = null;
}

/**
 * Membership check for the admin sign-in gate (not a permission check - the
 * per-request capability is decided by `can.reviewComment()` with the real
 * session). Used by the login page action, where checking the request session
 * is impossible: the cookie for the session it just created is not part of
 * the current request's headers.
 */
export async function isSiteOrganizationMember(userId: string): Promise<boolean> {
	const organizationId = await getSiteOrganizationId();
	if (!organizationId) return false;
	const rows = (await db.execute(
		sql`select 1 from "member" where "organization_id" = ${organizationId} and "user_id" = ${userId} limit 1`
	)) as unknown as Array<unknown>;
	return rows.length > 0;
}

import { sql } from 'drizzle-orm';

/**
 * Shared site-organization primitives.
 *
 * Imported by the app (`site-organization.ts`, `site-organization-bootstrap.ts`)
 * AND by `scripts/ensure-site-org.ts` (plain tsx), so this module must stay free
 * of `$lib` / `$env` imports - same rule, and same reason, as `owner-claim.ts`.
 */

export const SITE_ORGANIZATION_SLUG = 'web-lair';
export const SITE_ORGANIZATION_NAME = 'Web Lair';

/**
 * Stable advisory-lock namespace for the site-organization membership slot.
 *
 * The generated `member` table cannot carry a unique index on
 * (organization_id, user_id) - better-auth's tables are never hand-edited
 * (ledger §4.7) - so "exactly one owner membership" is an application-layer
 * invariant. Both writers (the setup bootstrap and the repair script) must
 * serialise through this transaction-scoped lock: tier ② of ledger §12-1.
 */
export const SITE_ORG_MEMBER_LOCK_KEY = 'web_lair.site_org_member';

/** Transaction-scoped lock: released automatically on COMMIT/ROLLBACK. */
export function siteMemberLock() {
	return sql`select pg_advisory_xact_lock(hashtext(${SITE_ORG_MEMBER_LOCK_KEY}))`;
}

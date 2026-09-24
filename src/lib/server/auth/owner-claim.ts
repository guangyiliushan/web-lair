import { sql } from 'drizzle-orm';

/**
 * Shared site-owner claim primitives.
 *
 * READ COMMITTED + `NOT EXISTS` is NOT enough on its own: two concurrent claims
 * that update different rows each evaluate the predicate against their own
 * statement snapshot, so both succeed (write skew - reproduced 2026-09-24 on a
 * scratch database; both rows ended up `role='owner'`). Callers must therefore
 * take the advisory lock below inside the same transaction before running the
 * conditional UPDATE.
 *
 * Imported by the app (`$lib/server/auth/owner`) AND by `scripts/seed-owner.ts`
 * (plain tsx), so this module must stay free of `$lib` / `$env` imports.
 */

/** Stable advisory-lock namespace for the single site-owner slot. */
export const SITE_OWNER_LOCK_KEY = 'web_lair.site_owner';

/** Transaction-scoped lock: released automatically on COMMIT/ROLLBACK. */
export function ownerClaimLock() {
	return sql`select pg_advisory_xact_lock(hashtext(${SITE_OWNER_LOCK_KEY}))`;
}

/** True while no *other* account already holds the owner role. */
export function noOtherOwner(userId: string) {
	return sql`not exists (select 1 from "user" as owner_row where owner_row.role = 'owner' and owner_row.id <> ${userId})`;
}

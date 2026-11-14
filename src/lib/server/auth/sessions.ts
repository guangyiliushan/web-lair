import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { session as authSession } from '$lib/server/db/auth.schema';

/**
 * Session revocation helpers (ledger §4.25, revised by settings-truth AC2).
 *
 * Email sign-in no longer prunes other sessions: admins get a real device list
 * on /admin/settings/account and revoke sessions explicitly. Pruning remains
 * where a credential change must invalidate other devices:
 *   - change password (`revokeOtherSessions: true` in better-auth)
 *   - 2FA enable/disable (the plugin rotates the current session)
 *   - backup-code regeneration (password-gated; keep the request token)
 */

/** Deletes every session of `userId` except the one carrying `keepToken`. */
export async function pruneOtherSessions(userId: string, keepToken: string) {
	await db
		.delete(authSession)
		.where(and(eq(authSession.userId, userId), ne(authSession.token, keepToken)));
}

/**
 * Deletes every session of `userId` except the newest one.
 *
 * Used after activating/disabling 2FA: better-auth rotates the current session
 * on those endpoints (creates a new row + cookie, deletes the old row), so the
 * caller's request token is already dead and cannot act as the "keep" marker.
 * The rotated session is the row created during this request; `id desc` only
 * breaks a same-second tie (B3.1 review).
 */
export async function pruneOtherSessionsKeepingNewest(userId: string) {
	await db.execute(sql`
		delete from ${authSession}
		where ${authSession.userId} = ${userId}
			and ${authSession.id} <> (
				select ${authSession.id} from ${authSession}
				where ${authSession.userId} = ${userId}
				order by ${authSession.createdAt} desc, ${authSession.id} desc
				limit 1
			)
	`);
}

/** Revokes one session by token (used when a verified account fails admission). */
export async function revokeSessionByToken(token: string) {
	await db.delete(authSession).where(eq(authSession.token, token));
}

import { and, eq, ne } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { session as authSession } from '$lib/server/db/auth.schema';

/**
 * Single-session policy (ledger §4.25): an admin sign-in keeps only the newest
 * session for that account, so an older leaked cookie stops working. Used by
 * the password sign-in and by the two-factor verification step.
 */
export async function pruneOtherSessions(userId: string, currentSessionId: string) {
	await db
		.delete(authSession)
		.where(and(eq(authSession.userId, userId), ne(authSession.id, currentSessionId)));
}

/** Revokes one session by id (used when a verified account fails admission). */
export async function revokeSessionById(sessionId: string) {
	await db.delete(authSession).where(eq(authSession.id, sessionId));
}

/** Resolves the session row a sign-in just created and returns its id. */
export async function findSessionIdByToken(
	token: string | null | undefined
): Promise<string | null> {
	if (!token) return null;
	const row = await db.query.session.findFirst({ where: eq(authSession.token, token) });
	const id = (row as { id?: string } | undefined)?.id;
	return typeof id === 'string' && id.length > 0 ? id : null;
}

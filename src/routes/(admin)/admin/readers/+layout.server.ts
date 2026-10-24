import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { user, session } from '$lib/server/db/auth.schema';
import { desc, max } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';

/**
 * The list is layout-level: both `/readers` and `/readers/[id]` render the list
 * pane, so they share one load. It reads no `url`/`params`, so selecting a row
 * does not refetch the list.
 *
 * `last_login` is the newest session the account has opened — there is no
 * dedicated column, and a session is the only durable trace of a sign-in.
 */
export const load: LayoutServerLoad = async () => {
	await requireAdminRole();

	const [rows, logins] = await Promise.all([
		db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				image: user.image,
				role: user.role,
				banned: user.banned,
				emailVerified: user.emailVerified,
				createdAt: user.createdAt
			})
			.from(user)
			.orderBy(desc(user.createdAt)),
		db
			.select({ userId: session.userId, lastLogin: max(session.updatedAt) })
			.from(session)
			.groupBy(session.userId)
	]);

	const lastLogin: Record<string, Date> = {};
	for (const row of logins) if (row.userId && row.lastLogin) lastLogin[row.userId] = row.lastLogin;

	const counts = { all: rows.length, owner: 0, reader: 0, banned: 0 };
	for (const row of rows) {
		if (row.banned) counts.banned += 1;
		else if (row.role === 'owner') counts.owner += 1;
		else counts.reader += 1;
	}

	// Public `id` is a text key here (better-auth), so it is passed through
	// untouched — unlike the uuid taxonomy routes, no `isUuid` guard applies.
	const mapped = rows.map((row) => ({
		id: row.id,
		name: row.name,
		email: row.email,
		avatar: row.image ?? '',
		role: (row.role === 'owner' ? 'owner' : 'reader') as 'owner' | 'reader',
		verified: row.emailVerified,
		banned: row.banned,
		joinedAt: row.createdAt,
		lastLogin: lastLogin[row.id] ?? null
	}));

	return {
		headerTitle: m.admin_readers(),
		readers: mapped,
		counts
	};
};

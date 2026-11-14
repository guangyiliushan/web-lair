import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { userProfiles, type ProfileLink } from '$lib/server/db/account';
import { user } from '$lib/server/db/auth.schema';
import { siteIdentity } from '$lib/server/db/settings';
import type { SiteOwner } from '$lib/config/owner-status';

/**
 * Public owner persona (M4 foundation, O-C2/OP-7).
 *
 * `site_identity` is a one-row pointer; `user_profiles` remains the single
 * source for the public fields. The hot path is one SQL statement:
 *
 *   site_identity -> user (role='owner') -> user_profiles (active)
 *
 * A missing profile row is not an error: the auth user's name/image are the
 * migration-era fallback so the header never goes blank. A missing pointer or
 * a pointer to a non-owner returns `null`, and callers fall back to
 * `SITE_OWNER_DEFAULT`; `owner:rebuild` repairs the pointer.
 */
export interface OwnerProfile {
	userId: string;
	displayName: string;
	headerLabel: string | null;
	avatarUrl: string | null;
	links: ProfileLink[] | null;
}

/** The read side only needs `select`; tests can inject a recording executor. */
export type OwnerProfileReadExecutor = Pick<typeof db, 'select'>;

export async function loadOwnerProfile(
	executor: OwnerProfileReadExecutor = db
): Promise<OwnerProfile | null> {
	const rows = await executor
		.select({
			userId: user.id,
			userName: user.name,
			userImage: user.image,
			displayName: userProfiles.displayName,
			headerLabel: userProfiles.headerLabel,
			avatarUrl: userProfiles.avatarUrl,
			links: userProfiles.links
		})
		.from(siteIdentity)
		.innerJoin(user, eq(user.id, siteIdentity.ownerUserId))
		.leftJoin(
			userProfiles,
			and(eq(userProfiles.userId, user.id), eq(userProfiles.status, 'active'))
		)
		.where(and(eq(siteIdentity.id, 1), eq(user.role, 'owner')))
		.limit(1);

	const row = rows[0];
	if (!row) return null;
	return {
		userId: row.userId,
		displayName: row.displayName ?? row.userName,
		headerLabel: row.headerLabel ?? null,
		avatarUrl: row.avatarUrl ?? row.userImage ?? null,
		links: row.links ?? null
	};
}

/** Header badge projection: full name stays the identity; label is layout-only. */
export function ownerProfileToSiteOwner(profile: OwnerProfile): SiteOwner {
	return { name: profile.displayName, avatar: profile.avatarUrl ?? '' };
}

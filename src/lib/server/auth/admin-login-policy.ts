import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { user as userTable } from '$lib/server/db/auth.schema';
import { isAdminRole } from '$lib/server/auth/owner';

/**
 * W1.6 (settings-truth plan, S3-B): GitHub is a reader-only sign-in method.
 *
 * Admin/owner accounts keep two credential paths - email + TOTP, or a passkey -
 * and a GitHub session must never become an admin session. The gate is
 * better-auth's official `user.validateUserInfo` hook: it runs before the
 * account/session write for OAuth sign-in AND for linking a provider to an
 * existing account, and a rejection redirects to the configured error URL with
 * `error=<code>` (no custom plugin, no auth-table change).
 */
export const ADMIN_BLOCKED_OAUTH_PROVIDERS = ['github'] as const;

/** Stable error code; the sign-in page maps it to a localized explanation. */
export const ADMIN_OAUTH_BLOCKED_CODE = 'admin_github_sign_in_blocked';

export interface UserValidationSource {
	method?: string;
	oauth?: { providerId?: string };
}

/** Pure decision: blocked provider + admin role => reject the provisioning. */
export function isBlockedAdminOAuthSignIn(input: {
	source: UserValidationSource;
	role: unknown;
}): boolean {
	const providerId = input.source.oauth?.providerId;
	return (
		input.source.method === 'oauth' &&
		typeof providerId === 'string' &&
		(ADMIN_BLOCKED_OAUTH_PROVIDERS as readonly string[]).includes(providerId) &&
		isAdminRole(input.role)
	);
}

function isBlockedProvider(source: UserValidationSource): boolean {
	const providerId = source.oauth?.providerId;
	return (
		source.method === 'oauth' &&
		typeof providerId === 'string' &&
		(ADMIN_BLOCKED_OAUTH_PROVIDERS as readonly string[]).includes(providerId)
	);
}

/**
 * The role is read from the local row, never from the provider profile: the
 * GitHub claim only names an identity, it does not grant a role. A missing row
 * means "new reader account" and is allowed; a failed lookup is thrown and
 * better-auth turns it into a 403 (fail-closed).
 */
export async function isBlockedAdminOAuthSignInForUser(
	source: UserValidationSource,
	userId: string | undefined
): Promise<boolean> {
	if (!isBlockedProvider(source) || !userId) return false;
	const rows = await db
		.select({ role: userTable.role })
		.from(userTable)
		.where(eq(userTable.id, userId))
		.limit(1);
	return isBlockedAdminOAuthSignIn({ source, role: rows[0]?.role });
}

export interface UserValidationData {
	user: { id?: string; email?: string } & Record<string, unknown>;
	source: UserValidationSource;
}

/**
 * `user.validateUserInfo` implementation. Returning `{ error }` rejects the
 * OAuth provisioning with that code; returning nothing allows it. Non-OAuth
 * methods (email, passkey, tailnet) are untouched.
 */
export async function validateUserProvisioning(
	data: UserValidationData
): Promise<void | { error: string; errorDescription: string }> {
	if (!isBlockedProvider(data.source)) return;
	if (await isBlockedAdminOAuthSignInForUser(data.source, data.user.id)) {
		return {
			error: ADMIN_OAUTH_BLOCKED_CODE,
			errorDescription: 'GitHub sign-in is not available for admin accounts'
		};
	}
}

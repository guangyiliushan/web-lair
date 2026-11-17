import { isAdminRole } from '$lib/server/auth/owner';

/**
 * GitHub is a reader-only sign-in method.
 *
 * GitHub must never mint an admin/owner session; those accounts keep two
 * credential paths - email + TOTP, or a passkey. The tailnet owner hand-off is
 * a separate, registered path (`tailscale-plugin.ts`), not covered here.
 *
 * The gate is better-auth's official `user.validateUserInfo` hook: it runs
 * before the account/session write for OAuth sign-in AND for linking a
 * provider to an existing account, and a rejection redirects to the configured
 * error URL with `error=<code>` (no custom plugin, no auth-table change).
 */
export const ADMIN_BLOCKED_OAUTH_PROVIDERS = ['github'] as const;

/** Stable error code; the sign-in page maps it to a localized explanation. */
export const ADMIN_OAUTH_BLOCKED_CODE = 'admin_github_sign_in_blocked';

export interface UserValidationSource {
	method?: string;
	oauth?: { providerId?: string };
}

/** The subset of better-auth's endpoint context this gate needs. */
export interface UserLookupContext {
	context: {
		internalAdapter: {
			findUserById(userId: string): Promise<{ id: string; role?: unknown } | null>;
		};
	};
}

function isBlockedProvider(source: UserValidationSource): boolean {
	const providerId = source.oauth?.providerId;
	return (
		source.method === 'oauth' &&
		typeof providerId === 'string' &&
		(ADMIN_BLOCKED_OAUTH_PROVIDERS as readonly string[]).includes(providerId)
	);
}

/** Pure decision: blocked provider + admin role => reject the provisioning. */
export function isBlockedAdminOAuthSignIn(input: {
	source: UserValidationSource;
	role: unknown;
}): boolean {
	return isBlockedProvider(input.source) && isAdminRole(input.role);
}

/**
 * The role is read from the local row, never from the provider profile: the
 * GitHub claim only names an identity, it does not grant a role. A missing row
 * means "new reader account" and is allowed; a failed lookup is thrown and
 * better-auth turns it into a 403 (fail-closed).
 *
 * The lookup goes through better-auth's own internal adapter rather than a
 * module-level drizzle handle: the OAuth callback may already hold a
 * transaction/connection when this hook runs.
 */
export async function isBlockedAdminOAuthSignInForUser(
	context: UserLookupContext,
	source: UserValidationSource,
	userId: string | undefined
): Promise<boolean> {
	if (!isBlockedProvider(source) || !userId) return false;
	const row = await context.context.internalAdapter.findUserById(userId);
	return isBlockedAdminOAuthSignIn({ source, role: row?.role });
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
	data: UserValidationData,
	context: UserLookupContext
): Promise<void | { error: string; errorDescription: string }> {
	if (!isBlockedProvider(data.source)) return;
	if (await isBlockedAdminOAuthSignInForUser(context, data.source, data.user.id)) {
		// A security-relevant refusal must leave a server-side trace; better-auth
		// only redirects, and the user's URL is not an operator signal.
		console.warn('[auth] admin GitHub sign-in blocked', { userId: data.user.id });
		return {
			error: ADMIN_OAUTH_BLOCKED_CODE,
			errorDescription: 'GitHub sign-in is not available for admin accounts'
		};
	}
}

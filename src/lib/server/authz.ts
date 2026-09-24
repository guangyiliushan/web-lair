import { error, redirect } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { ADMIN_BASE_PATH, getAdminConfig } from '$lib/server/config/admin';
import { isAdminRole, type AdminRole } from '$lib/server/auth/owner';
import { auth } from '$lib/server/auth';

export interface AdminContext {
	userId: string;
	role: AdminRole;
}

/** Minimal shape shared by better-auth's `User` and the drizzle row. */
interface SessionUser {
	id: string;
	email?: string | null;
	emailVerified?: boolean;
	role?: unknown;
}

export function getUserRole(user: SessionUser | null | undefined): AdminRole | null {
	return isAdminRole(user?.role) ? user.role : null;
}

export function adminContextFor(user: SessionUser | null | undefined): AdminContext | null {
	const role = getUserRole(user);
	if (!user || !role) return null;
	return { userId: user.id, role };
}

/**
 * B2 (ledger §4.21): entering the /admin shell needs a site role or any
 * backend capability inside the site organization. Which pages a capability
 * holder without a site role may open is decided per page - see
 * `requireAdminWorkspace`.
 *
 * NOTE: this is async - always `await` it. The promise object itself is
 * truthy, so a forgotten await fails open (B2.1 review fix, F5).
 */
export async function hasAnyAdminCapability(
	user: SessionUser | null | undefined
): Promise<boolean> {
	if (getUserRole(user) !== null) return true;
	return can.reviewComment();
}

/**
 * Per-request memo for capability checks (B2.1 review fix): the layout guard,
 * the page load and the action all ask the same question, and every
 * `hasPermission` call costs a session lookup + member lookup. Keyed by the
 * request event object, so the map dies with the request.
 */
const commentCapabilityCache = new WeakMap<object, Map<string, Promise<boolean>>>();

/** The comment actions declared on the shared access-control statement. */
type CommentAction = 'review' | 'approve' | 'reject' | 'delete';

async function commentCapability(actions: readonly CommentAction[]): Promise<boolean> {
	const event = getRequestEvent();
	const key = actions.join(',');
	let perEvent = commentCapabilityCache.get(event);
	if (!perEvent) {
		perEvent = new Map();
		commentCapabilityCache.set(event, perEvent);
	}
	const cached = perEvent.get(key);
	if (cached) return cached;
	const pending = (async () => {
		try {
			const { success } = await auth.api.hasPermission({
				headers: event.request.headers,
				body: { permissions: { comment: [...actions] } }
			});
			return Boolean(success);
		} catch (error) {
			// Fail closed, but leave the reason in the log: "no session", "not a
			// member", "no active organization" and plugin errors all land here
			// and the 403 alone cannot tell them apart (B2.1 review fix).
			console.warn(
				'[authz] comment permission check failed; denying',
				key,
				error instanceof Error ? error.message : error
			);
			return false;
		}
	})();
	perEvent.set(key, pending);
	return pending;
}

/**
 * The single entry point for comment permissions (ledger §4.15): wraps the
 * organization plugin's `hasPermission` endpoint. Fails closed - no session,
 * not a member, no active organization, or a plugin error all resolve to
 * `false` (with the reason logged).
 */
export const can = {
	reviewComment: () => commentCapability(['review']),
	approveComment: () => commentCapability(['approve']),
	rejectComment: () => commentCapability(['reject'])
};

function redirectToLogin(pathname: string, search = ''): never {
	const config = getAdminConfig();
	redirect(303, `${config.loginPath}?redirectTo=${encodeURIComponent(pathname + search)}`);
}

export function requireUser() {
	const { locals, url } = getRequestEvent();
	if (!locals.user) {
		redirect(303, `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
	}
	return locals.user;
}

/**
 * Guard for the /admin workspace. B2 (ledger §4.21): the shell admits any
 * capability holder, but only onto the pages their capability covers - the
 * comment queue - while every other page stays owner/admin. Page and action
 * guards re-check the specific permission; see `requireCommentReviewer`.
 */
export async function requireAdminWorkspace(): Promise<void> {
	const { url } = getRequestEvent();
	const commentsPath = `${ADMIN_BASE_PATH}/comments`;
	const isCommentsPath =
		url.pathname === commentsPath || url.pathname.startsWith(`${commentsPath}/`);
	if (isCommentsPath) {
		await requireCommentReviewer();
		return;
	}
	await requireAdminRole();
}

/** Owner/admin only - the guard for every non-comment admin page. */
export async function requireAdminRole(): Promise<void> {
	const { locals, url } = getRequestEvent();
	if (!locals.session || !locals.user) {
		redirectToLogin(url.pathname, url.search);
	}
	if (adminContextFor(locals.user)) return;
	// Capability holders without a site role get sent to the one page they can use.
	if (await can.reviewComment()) {
		redirect(303, `${ADMIN_BASE_PATH}/comments`);
	}
	redirectToLogin(url.pathname, url.search);
}

/** Comment queue guard: `comment: ['review']` capability (B2, ledger §4.15). */
export async function requireCommentReviewer() {
	const { locals, url } = getRequestEvent();
	if (!locals.session || !locals.user) {
		redirectToLogin(url.pathname, url.search);
	}
	if (!(await can.reviewComment())) {
		error(403, { message: 'Comment review permission required.' });
	}
	return locals.user;
}

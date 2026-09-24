import { error, redirect } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { ADMIN_BASE_PATH, getAdminConfig } from '$lib/server/config/admin';
import { isAdminRole, type AdminRole } from '$lib/server/auth/owner';
import { auth } from '$lib/server/auth';

export interface AdminContext {
	userId: string;
	role: AdminRole;
}

/** Org-side workspace context: a member holding the comment-review capability (B2). */
export interface ReviewerContext {
	userId: string;
	role: 'reviewer';
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

/**
 * B2 (ledger §4.21): entering the /admin shell needs a site role or any
 * backend capability inside the site organization. Which pages a capability
 * holder without a site role may open is decided per page - see
 * `requireAdminWorkspace`.
 */
export async function hasAnyAdminCapability(
	user: SessionUser | null | undefined
): Promise<boolean> {
	if (getUserRole(user) !== null) return true;
	return can.reviewComment();
}

/**
 * The single entry point for comment permissions (ledger §4.15): wraps the
 * organization plugin's `hasPermission` endpoint. Fails closed - no session,
 * not a member, no active organization, or a plugin error all resolve to
 * `false`.
 */
export const can = {
	async reviewComment(): Promise<boolean> {
		const { request } = getRequestEvent();
		try {
			const { success } = await auth.api.hasPermission({
				headers: request.headers,
				body: { permissions: { comment: ['review'] } }
			});
			return Boolean(success);
		} catch {
			return false;
		}
	}
};

export function adminContextFor(user: SessionUser | null | undefined): AdminContext | null {
	const role = getUserRole(user);
	if (!user || !role) return null;
	return { userId: user.id, role };
}

export function requireUser() {
	const { locals, url } = getRequestEvent();
	if (!locals.user) {
		const redirectTo = url.pathname + url.search;
		redirect(303, `/login?redirectTo=${encodeURIComponent(redirectTo)}`);
	}
	return locals.user;
}

/** Reserved for flows that need a verified email but no admin role (B2+). */
export function requireVerifiedUser() {
	const user = requireUser();
	if (!user.emailVerified) {
		redirect(303, '/verify-email');
	}
	return user;
}

/**
 * Guard for the /admin workspace. B2 (ledger §4.21): the shell admits any
 * capability holder, but only onto the pages their capability covers - the
 * comment queue - while every other page stays owner/admin. Page and action
 * guards re-check the specific permission; see `requireCommentReviewer`.
 */
export async function requireAdminWorkspace(): Promise<AdminContext | ReviewerContext> {
	const { url } = getRequestEvent();
	const commentsPath = `${ADMIN_BASE_PATH}/comments`;
	const isCommentsPath =
		url.pathname === commentsPath || url.pathname.startsWith(`${commentsPath}/`);
	if (isCommentsPath) {
		const user = await requireCommentReviewer();
		return { userId: user.id, role: 'reviewer' };
	}
	return requireAdminRole();
}

/** Owner/admin only - the guard for every non-comment admin page. */
export async function requireAdminRole(): Promise<AdminContext> {
	const { locals, url } = getRequestEvent();
	const config = getAdminConfig();
	const redirectTo = `${config.loginPath}?redirectTo=${encodeURIComponent(url.pathname + url.search)}`;
	if (!locals.session || !locals.user) {
		redirect(303, redirectTo);
	}
	const context = adminContextFor(locals.user);
	if (context) return context;
	// Capability holders without a site role get sent to the one page they can use.
	if (await can.reviewComment()) {
		redirect(303, `${ADMIN_BASE_PATH}/comments`);
	}
	redirect(303, redirectTo);
}

/** Comment queue guard: `comment: ['review']` capability (B2, ledger §4.15). */
export async function requireCommentReviewer() {
	const { locals, url } = getRequestEvent();
	const config = getAdminConfig();
	if (!locals.session || !locals.user) {
		redirect(
			303,
			`${config.loginPath}?redirectTo=${encodeURIComponent(url.pathname + url.search)}`
		);
	}
	if (!(await can.reviewComment())) {
		error(403, { message: 'Comment review permission required.' });
	}
	return locals.user;
}

/** Guard for owner-only operations (the role is unique by app-layer convention). */
export async function requireAdminOwner() {
	const { locals, url } = getRequestEvent();

	if (!locals.user) {
		const config = getAdminConfig();
		redirect(
			303,
			`${config.loginPath}?redirectTo=${encodeURIComponent(url.pathname + url.search)}`
		);
	}

	if (!locals.user.emailVerified) {
		redirect(303, '/verify-email');
	}

	if (getUserRole(locals.user) !== 'owner') {
		error(403, { message: 'Admin access required.' });
	}

	return locals.user;
}

import { error, redirect } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { getAdminConfig } from '$lib/server/config/admin';
import { isAdminRole, type AdminRole } from '$lib/server/auth/owner';

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

/**
 * B1: owner and admin both see the /admin workspace (ledger Q15). B2 widens
 * this with the organization-plugin capacity, which is why the guard is named
 * after the capability rather than a single role.
 */
export function hasAnyAdminCapability(user: SessionUser | null | undefined): boolean {
	return isAdminRole(user?.role);
}

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

export function requireVerifiedUser() {
	const user = requireUser();
	if (!user.emailVerified) {
		redirect(303, '/verify-email');
	}
	return user;
}

/** Guard for the /admin workspace: signed in with owner or admin role. */
export function requireAdminWorkspace(): AdminContext {
	const { locals, url } = getRequestEvent();
	const config = getAdminConfig();
	const context = adminContextFor(locals.user);

	if (!locals.session || !context) {
		const redirectTo = url.pathname + url.search;
		redirect(303, `${config.loginPath}?redirectTo=${encodeURIComponent(redirectTo)}`);
	}

	return context;
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

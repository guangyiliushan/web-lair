import { redirect } from '@sveltejs/kit';
import { requireAdminRole } from '$lib/server/authz';
import type { PageServerLoad } from './$types';

/**
 * `/admin` is an entry point, not a dashboard route: the sidebar's active
 * state is segment-based, so keeping the dashboard at the base path made it
 * highlight on every admin page. The real page lives at `/admin/dashboard`.
 *
 * The role guard runs before the redirect so capability-only accounts
 * (comment reviewers) are sent to their own surface instead of bouncing
 * through the dashboard's guard.
 */
export const load: PageServerLoad = async () => {
	await requireAdminRole();
	redirect(307, '/admin/dashboard');
};

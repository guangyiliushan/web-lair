import type { PageServerLoad } from './$types';
import { requireAdminRole } from '$lib/server/authz';
import { loadOwnerEditorView } from '$lib/server/services/owner-profile';
import { settingAccess } from '$lib/server/settings/tiers';

/**
 * Foundation read view for Profile & Preferences (W3.5). The edit form is
 * intentionally absent: W4 adds the save/cancel/dirty pattern on top of the
 * W3.3 service, so this page must not render an input whose value is not
 * persisted. `editable` is the guard the W3.4 permission matrix exposes to
 * the page: only the pointer owner sees an edit affordance.
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const view = await loadOwnerEditorView();
	const admin = event.locals.admin;
	const access = settingAccess(admin?.role, 'profile');
	return {
		view,
		editable: Boolean(
			access.editable && admin?.role === 'owner' && view.pointerUserId === admin.userId
		)
	};
};

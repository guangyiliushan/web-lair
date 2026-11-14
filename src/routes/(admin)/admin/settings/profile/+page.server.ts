import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { requireAdminRole } from '$lib/server/authz';
import {
	OwnerProfileError,
	loadOwnerEditorView,
	saveOwnerProfile,
	type OwnerProfileInput
} from '$lib/server/services/owner-profile';
import { assertSettingWrite, settingAccess } from '$lib/server/settings/tiers';

/**
 * Profile & Preferences (W4.1): the owner's public persona. Only the pointer
 * owner may edit; an admin sees the same values read-only. `email` is read
 * from the auth user and never written here; `bio` has no public surface yet
 * and is deliberately absent.
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

function stringField(form: FormData, name: string): string {
	return (form.get(name) ?? '').toString();
}

/** Rows arrive as parallel `linkPlatform`/`linkHref`/`linkLabel` arrays. */
function parseLinks(form: FormData): OwnerProfileInput['links'] {
	const platforms = form.getAll('linkPlatform').map(String);
	const hrefs = form.getAll('linkHref').map(String);
	const labels = form.getAll('linkLabel').map(String);
	const links: NonNullable<OwnerProfileInput['links']> = [];
	const rows = Math.max(platforms.length, hrefs.length);
	for (let index = 0; index < rows; index += 1) {
		const platform = (platforms[index] ?? '').trim();
		const href = (hrefs[index] ?? '').trim();
		if (platform === '' && href === '') continue;
		const label = (labels[index] ?? '').trim();
		links.push(label ? { platform, href, label } : { platform, href });
	}
	return links;
}

export const actions: Actions = {
	save: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'profile', 'profile.public_identity');

		const form = await event.request.formData();
		const actorId = event.locals.user?.id ?? '';

		try {
			const saved = await saveOwnerProfile(
				{
					displayName: stringField(form, 'displayName'),
					headerLabel: stringField(form, 'headerLabel'),
					avatarUrl: stringField(form, 'avatarUrl'),
					links: parseLinks(form)
				},
				{ actorId }
			);
			return {
				step: 'profile' as const,
				ok: true,
				profile: saved,
				message: m.admin_settings_profile_saved()
			};
		} catch (caught) {
			if (caught instanceof OwnerProfileError) {
				return fail(caught.status, {
					message: caught.message,
					step: 'profile' as const,
					ok: false
				});
			}
			console.warn(
				'[settings] profile save failed:',
				caught instanceof Error ? caught.message : caught
			);
			return fail(500, {
				message: m.admin_settings_profile_err_save(),
				step: 'profile' as const,
				ok: false
			});
		}
	}
};

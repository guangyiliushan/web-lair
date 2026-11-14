import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { getOption, setOption } from '$lib/server/config/options-registry';
import { assertSettingWrite, settingAccess } from '$lib/server/settings/tiers';

/**
 * Content settings (W6): comments, privacy, friends, reading presence and the
 * notes gate. `comments.moderation` stays owned by the AI page (single
 * writer), which is why this page links to it instead of duplicating it.
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const [
		commentsEnabled,
		moderation,
		presenceEnabled,
		readerView,
		readerDots,
		notesGate,
		friendsApply
	] = await Promise.all([
		getOption('comments.enabled'),
		getOption('comments.moderation'),
		getOption('presence.enabled'),
		getOption('presence.readerView'),
		getOption('presence.readerDots'),
		getOption('notes.gate'),
		getOption('friends.apply')
	]);
	const role = event.locals.admin?.role;
	return {
		commentsEnabled,
		moderation: moderation.enabled,
		presence: { enabled: presenceEnabled, readerView, readerDots },
		notesGate,
		friendsApply,
		editable: {
			comments: settingAccess(role, 'content', 'comments.enabled').editable,
			privacy: settingAccess(role, 'content', 'comments.privacy').editable,
			friends: settingAccess(role, 'content', 'friends.apply').editable,
			presence: settingAccess(role, 'content', 'presence.enabled').editable,
			notes: settingAccess(role, 'content', 'notes.gate').editable
		}
	};
};

export const actions: Actions = {
	/** W6.1 (C1): the site-wide switch for NEW comments. */
	saveComments: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'comments.enabled');
		const form = await request.formData();
		const enabled = form.get('enabled') !== null;
		await setOption('comments.enabled', enabled);
		await recordActivity(db, {
			event: 'comments.settings_update',
			actorId: locals.user?.id ?? null,
			payload: { fields: ['comments.enabled'], enabled },
			deliver: false
		});
		return { message: m.admin_settings_content_flash_comments_saved() };
	}
};

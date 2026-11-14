import type { Actions, PageServerLoad } from './$types';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { m } from '$lib/paraglide/messages';
import { db } from '$lib/server/db';
import { requireAdminRole } from '$lib/server/authz';
import { recordActivity } from '$lib/server/audit';
import { getOption, setOption } from '$lib/server/config/options-registry';
import { isGeoipConfigured } from '$lib/server/security/geoip';
import { settingAccess, assertSettingWrite } from '$lib/server/settings/tiers';

/**
 * Content settings (W6): comments, privacy, friends, reading presence and the
 * notes gate. `comments.moderation` stays owned by the AI page (single
 * writer), which is why this page links to it instead of duplicating it.
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const [
		commentsEnabled,
		commentsPrivacy,
		moderation,
		presenceEnabled,
		readerView,
		readerDots,
		notesGate,
		friendsApply
	] = await Promise.all([
		getOption('comments.enabled'),
		getOption('comments.privacy'),
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
		commentsPrivacy,
		/** collectCountry needs a deployment header provider (C2). */
		geoipConfigured: isGeoipConfigured(),
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
	},

	/** W6.2 (C2/C4/C5): request-time IP policy for comments; owner-only. */
	savePrivacy: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'comments.privacy');
		const form = await request.formData();
		const raw = (key: string) => (form.get(key) ?? '').toString().trim();
		const lines = (key: string) =>
			raw(key)
				.split('\n')
				.map((entry) => entry.trim())
				.filter(Boolean);
		const enabled = form.get('enabled') !== null;
		const collectCountry = form.get('collectCountry') !== null;
		const showCountry = form.get('showCountry') !== null;
		const retentionDays = Number(raw('retentionDays'));
		if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
			return fail(400, { message: m.admin_settings_content_privacy_retention_hint() });
		}
		if (collectCountry && !isGeoipConfigured()) {
			// No provider = the sub-switch is unavailable, not silently useless.
			return fail(400, { message: m.admin_settings_content_privacy_provider_missing() });
		}
		const blockedCidrs = lines('blockedCidrs');
		const value = {
			enabled,
			// Sub-switches cannot stay on under a closed master switch: a stale
			// form (or a hand-crafted POST) must not smuggle collection past off.
			collectCountry: enabled && collectCountry,
			showCountry: enabled && collectCountry && showCountry,
			retentionDays,
			blockedCidrs
		};
		try {
			await setOption('comments.privacy', value);
		} catch (caught) {
			if (caught instanceof z.ZodError) {
				return fail(400, {
					message: caught.issues[0]?.message ?? m.admin_settings_content_privacy_cidrs_hint()
				});
			}
			throw caught;
		}
		await recordActivity(db, {
			event: 'privacy.update',
			actorId: locals.user?.id ?? null,
			payload: {
				fields: [
					'comments.privacy.enabled',
					'comments.privacy.collectCountry',
					'comments.privacy.showCountry',
					'comments.privacy.retentionDays',
					'comments.privacy.blockedCidrs'
				],
				...value
			},
			deliver: false
		});
		return { message: m.admin_settings_content_flash_privacy_saved() };
	}
};

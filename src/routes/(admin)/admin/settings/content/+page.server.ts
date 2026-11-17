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
 * Content settings: comments, privacy, friends, reading presence and the
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
		friendsApply,
		friendsChecks,
		friendsPolicy
	] = await Promise.all([
		getOption('comments.enabled'),
		getOption('comments.privacy'),
		getOption('comments.moderation'),
		getOption('presence.enabled'),
		getOption('presence.readerView'),
		getOption('presence.readerDots'),
		getOption('notes.gate'),
		getOption('friends.apply'),
		getOption('friends.checks'),
		getOption('friends.policy')
	]);
	const role = event.locals.admin?.role;
	return {
		commentsEnabled,
		commentsPrivacy,
		/** collectCountry needs a deployment header provider. */
		geoipConfigured: isGeoipConfigured(),
		moderation: moderation.enabled,
		presence: { enabled: presenceEnabled, readerView, readerDots },
		notesGate,
		friends: { apply: friendsApply, checks: friendsChecks, policy: friendsPolicy },
		editable: {
			comments: settingAccess(role, 'content', 'comments.enabled').editable,
			privacy: settingAccess(role, 'content', 'comments.privacy').editable,
			friends: settingAccess(role, 'content', 'friends.apply').editable,
			presence: settingAccess(role, 'content', 'presence.enabled').editable,
			notes: settingAccess(role, 'content', 'notes.gate').editable
		}
	};
};

/**
 * Zod issues carry the localized registry copy for every bounded field; this
 * keeps the first one and never invents a message of its own.
 */
function firstIssue(caught: z.ZodError, fallback: string): string {
	return caught.issues[0]?.message ?? fallback;
}

export const actions: Actions = {
	/** The site-wide switch for NEW comments. */
	saveComments: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'comments.enabled');
		const form = await request.formData();
		const enabled = form.get('enabled') !== null;
		await setOption('comments.enabled', enabled);
		await recordActivity(db, {
			event: 'comments.settings_update',
			actorId: locals.user?.id ?? null,
			payload: { fields: ['enabled'], enabled },
			deliver: false
		});
		return { message: m.admin_settings_content_flash_comments_saved() };
	},

	/** Request-time IP policy for comments; owner-only. */
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
				fields: ['enabled', 'collectCountry', 'showCountry', 'retentionDays', 'blockedCidrs'],
				...value
			},
			deliver: false
		});
		return { message: m.admin_settings_content_flash_privacy_saved() };
	},

	/** Friend-link application switches. */
	saveFriendsApply: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'friends.apply');
		const form = await request.formData();
		const value = {
			enabled: form.get('enabled') !== null,
			allowSubPath: form.get('allowSubPath') !== null
		};
		await setOption('friends.apply', value);
		await recordActivity(db, {
			event: 'friends.update',
			actorId: locals.user?.id ?? null,
			payload: { fields: ['enabled', 'allowSubPath'], ...value },
			deliver: false
		});
		return { message: m.admin_settings_content_flash_friends_saved() };
	},

	/** The checker cadence and strike policy. */
	saveFriendsChecks: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'friends.checks');
		const form = await request.formData();
		const numberField = (name: string) => Number((form.get(name) ?? '').toString().trim());
		const value = {
			enabled: form.get('enabled') !== null,
			cadenceHours: numberField('cadenceHours'),
			failStreak: numberField('failStreak'),
			backlinkStreak: numberField('backlinkStreak'),
			graceDays: numberField('graceDays'),
			timeoutMs: numberField('timeoutMs'),
			concurrency: numberField('concurrency')
		};
		try {
			await setOption('friends.checks', value);
		} catch (caught) {
			if (caught instanceof z.ZodError) {
				return fail(400, { message: firstIssue(caught, m.comment_error_generic()) });
			}
			throw caught;
		}
		await recordActivity(db, {
			event: 'friends.update',
			actorId: locals.user?.id ?? null,
			payload: {
				fields: [
					'enabled',
					'cadenceHours',
					'failStreak',
					'backlinkStreak',
					'graceDays',
					'timeoutMs',
					'concurrency'
				],
				...value
			},
			deliver: false
		});
		return { message: m.admin_settings_content_flash_friends_saved() };
	},

	/** The link policy lists. */
	saveFriendsPolicy: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'friends.policy');
		const form = await request.formData();
		const lines = (name: string) =>
			(form.get(name) ?? '')
				.toString()
				.split('\n')
				.map((entry) => entry.trim())
				.filter(Boolean);
		const value = {
			blockedHostSuffixes: lines('blockedHostSuffixes'),
			blockedTlds: lines('blockedTlds'),
			acceptedBacklinkHosts: lines('acceptedBacklinkHosts'),
			publicBannedList: form.get('publicBannedList') !== null
		};
		try {
			await setOption('friends.policy', value);
		} catch (caught) {
			if (caught instanceof z.ZodError) {
				return fail(400, { message: firstIssue(caught, m.comment_error_generic()) });
			}
			throw caught;
		}
		await recordActivity(db, {
			event: 'friends.update',
			actorId: locals.user?.id ?? null,
			payload: {
				fields: ['blockedHostSuffixes', 'blockedTlds', 'acceptedBacklinkHosts', 'publicBannedList'],
				...value
			},
			deliver: false
		});
		return { message: m.admin_settings_content_flash_friends_saved() };
	},

	/** Reading-experience presence stays on Content. */
	savePresence: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'presence.enabled');
		const form = await request.formData();
		const enabled = form.get('enabled') !== null;
		const readerView = form.get('readerView') !== null;
		const readerDots = form.get('readerDots') !== null;
		await setOption('presence.enabled', enabled);
		await setOption('presence.readerView', readerView);
		await setOption('presence.readerDots', readerDots);
		await recordActivity(db, {
			event: 'presence.update',
			actorId: locals.user?.id ?? null,
			payload: {
				fields: ['enabled', 'readerView', 'readerDots'],
				enabled,
				readerView,
				readerDots
			},
			deliver: false
		});
		return { message: m.admin_settings_content_flash_presence_saved() };
	},

	/** The password-gate unlock TTL (notes.gate.ttlDays). */
	saveNotesGate: async ({ locals, request }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'content', 'notes.gate');
		const form = await request.formData();
		const ttlDays = Number((form.get('ttlDays') ?? '').toString().trim());
		try {
			await setOption('notes.gate', { ttlDays });
		} catch (caught) {
			if (caught instanceof z.ZodError) {
				return fail(400, {
					message: firstIssue(caught, m.admin_settings_content_notes_ttl_hint())
				});
			}
			throw caught;
		}
		await recordActivity(db, {
			event: 'notes_gate.update',
			actorId: locals.user?.id ?? null,
			payload: { fields: ['ttlDays'], ttlDays },
			deliver: false
		});
		return { message: m.admin_settings_content_flash_notes_saved() };
	}
};

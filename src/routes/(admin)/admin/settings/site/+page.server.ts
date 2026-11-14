import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import { requireAdminRole } from '$lib/server/authz';
import {
	getOption,
	setOption,
	validateOption,
	OptionWriteError,
	OPTION_LANGS
} from '$lib/server/config/options-registry';
import { ADMIN_BASE_PATH } from '$lib/server/config/admin';
import { getPublicOrigin } from '$lib/server/origin';
import { APP_VERSION } from '$lib/server/version';
import { assertSettingWrite, settingAccess } from '$lib/server/settings/tiers';
import { db } from '$lib/server/db';
import { recordActivity } from '$lib/server/audit';
import { m } from '$lib/paraglide/messages';
import type { PageServerLoad, Actions } from './$types';

/**
 * Settings → Site (W5, decision register §3A). Four real forms with real
 * consumers:
 *
 * - `saveInfo`     site.info      name/description/avatar (admin) -> friend
 *                                 cards, llms.txt, manifest, og:site_name
 * - `saveIcon`     site.icon      favicon URL (admin); version is bumped here
 *                                 so the root layout's `?v=` changes
 * - `saveTimezone` site.timezone  IANA zone (admin) -> dates, schedules, notes
 * - `saveLanguages` (W5.4)        the owner-only language pair, written in one
 *                                 transaction because default_lang ∈ enabled
 *
 * Deployment and search indexing are read-only facts on the same page - no
 * form, no Save, no TLS controls (S2/S8/SE1-SE4).
 *
 * Every action re-checks the tier itself (`assertSettingWrite`): the settings
 * layout guard does not run before a form action, and a role check in `load`
 * only decides what to render. The audit row (`site.update`) carries the
 * changed field names, no ref arc, and is not in `WEBHOOK_EVENT_ROSTER`, so it
 * fans out to zero deliveries (R-7 / §3A.4).
 */

type SiteOp = 'info' | 'icon' | 'timezone' | 'languages';

/** Zod issues already carry the localized registry copy. */
function issueText(error: z.ZodError, fallback: () => string): string {
	return error.issues[0]?.message ?? fallback();
}

function formText(form: FormData, key: string): string {
	return String(form.get(key) ?? '');
}

export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const [info, languages, defaultLang, timezone, icon] = await Promise.all([
		getOption('site.info'),
		getOption('site.languages'),
		getOption('site.default_lang'),
		getOption('site.timezone'),
		getOption('site.icon')
	]);
	const role = event.locals.admin?.role;
	return {
		info,
		languages,
		defaultLang,
		timezone,
		icon,
		langs: [...OPTION_LANGS],
		canEditInfo: settingAccess(role, 'site', 'site.info').editable,
		canEditIcon: settingAccess(role, 'site', 'site.icon').editable,
		canEditTimezone: settingAccess(role, 'site', 'site.timezone').editable,
		canEditLanguages: settingAccess(role, 'site', 'site.languages').editable,
		deployment: {
			origin: getPublicOrigin(),
			adminPath: ADMIN_BASE_PATH,
			environment: process.env.NODE_ENV ?? 'development',
			version: env.APP_VERSION?.trim() || APP_VERSION
		}
	};
};

export const actions: Actions = {
	saveInfo: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'site', 'site.info');
		const form = await request.formData();
		const value = {
			name: formText(form, 'name'),
			description: formText(form, 'description'),
			avatar: formText(form, 'avatar')
		};
		let info;
		try {
			info = validateOption('site.info', value);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return fail(400, {
					op: 'info' satisfies SiteOp,
					error: true,
					message: issueText(error, () => m.admin_settings_site_err_info())
				});
			}
			throw error;
		}
		await db.transaction(async (tx) => {
			await setOption('site.info', info, tx);
			await recordActivity(tx, {
				event: 'site.update',
				actorId: locals.user?.id ?? null,
				payload: { fields: ['info'] }
			});
		});
		return { op: 'info' satisfies SiteOp, message: m.admin_settings_site_saved_info() };
	},

	saveIcon: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'site', 'site.icon');
		const form = await request.formData();
		const current = await getOption('site.icon');
		let icon;
		try {
			// Version moves forward on every save. The shared SettingsForm only
			// submits when the URL string changes, so the bump follows an icon
			// change; it keeps the `?v=` cache bust moving (S3).
			icon = validateOption('site.icon', {
				url: formText(form, 'url'),
				version: current.version + 1
			});
		} catch (error) {
			if (error instanceof z.ZodError) {
				return fail(400, {
					op: 'icon' satisfies SiteOp,
					error: true,
					message: issueText(error, () => m.admin_settings_site_err_icon())
				});
			}
			throw error;
		}
		await db.transaction(async (tx) => {
			await setOption('site.icon', icon, tx);
			await recordActivity(tx, {
				event: 'site.update',
				actorId: locals.user?.id ?? null,
				payload: { fields: ['icon'] }
			});
		});
		return { op: 'icon' satisfies SiteOp, message: m.admin_settings_site_saved_icon() };
	},

	saveTimezone: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'site', 'site.timezone');
		const form = await request.formData();
		const tz = formText(form, 'tz').trim();
		let timezone;
		try {
			timezone = validateOption('site.timezone', tz);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return fail(400, {
					op: 'timezone' satisfies SiteOp,
					error: true,
					message: issueText(error, () => m.admin_settings_site_err_timezone())
				});
			}
			throw error;
		}
		try {
			await db.transaction(async (tx) => {
				await setOption('site.timezone', timezone, tx);
				await recordActivity(tx, {
					event: 'site.update',
					actorId: locals.user?.id ?? null,
					payload: { fields: ['timezone'] }
				});
			});
		} catch (error) {
			// ICU and PostgreSQL disagree on some zone names; the registry
			// write gate rejects those (OptionWriteError). A stored value
			// would 500 every belongs-to query, so this is a 400, not a 500.
			if (error instanceof OptionWriteError) {
				return fail(400, {
					op: 'timezone' satisfies SiteOp,
					error: true,
					message: error.message
				});
			}
			throw error;
		}
		return {
			op: 'timezone' satisfies SiteOp,
			message: m.admin_settings_site_saved_timezone()
		};
	},

	/**
	 * Owner-only language pair (S7, W5.4): `site.languages` and
	 * `site.default_lang` are validated as a pair and written in ONE
	 * transaction - `setOption` deliberately does no cross-key validation, so
	 * a crash between two separate writes must not leave `default_lang`
	 * outside the enabled set. Disabling a language only changes the
	 * translation/llms candidate set; existing content and translations stay
	 * (the page copy says so).
	 */
	saveLanguages: async ({ request, locals }) => {
		await requireAdminRole();
		assertSettingWrite(locals.admin?.role, 'site', 'site.languages');
		const form = await request.formData();
		const enabled = form.getAll('enabled').map((value) => value.toString());
		const defaultLang = formText(form, 'default');

		let languages;
		try {
			// Min 1, no duplicates, canonical order (registry schema).
			languages = validateOption('site.languages', { enabled });
		} catch (error) {
			if (error instanceof z.ZodError) {
				return fail(400, {
					op: 'languages' satisfies SiteOp,
					error: true,
					message: issueText(error, () => m.admin_settings_site_err_languages())
				});
			}
			throw error;
		}

		let validDefault;
		try {
			validDefault = validateOption('site.default_lang', defaultLang);
		} catch (error) {
			if (error instanceof z.ZodError) {
				return fail(400, {
					op: 'languages' satisfies SiteOp,
					error: true,
					message: m.admin_settings_site_err_default_lang()
				});
			}
			throw error;
		}
		if (!(languages.enabled as readonly string[]).includes(validDefault)) {
			return fail(400, {
				op: 'languages' satisfies SiteOp,
				error: true,
				message: m.admin_settings_site_err_default_lang()
			});
		}

		await db.transaction(async (tx) => {
			await setOption('site.languages', languages, tx);
			await setOption('site.default_lang', validDefault, tx);
			await recordActivity(tx, {
				event: 'site.update',
				actorId: locals.user?.id ?? null,
				payload: { fields: ['languages', 'default_lang'] }
			});
		});
		return {
			op: 'languages' satisfies SiteOp,
			message: m.admin_settings_site_saved_languages()
		};
	}
};

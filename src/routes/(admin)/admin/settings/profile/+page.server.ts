import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { m } from '$lib/paraglide/messages';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { requireAdminRole } from '$lib/server/authz';
import {
	OwnerProfileError,
	loadHomeHero,
	loadOwnerEditorView,
	saveHomeHero,
	saveOwnerProfile,
	type HomeHeroInput,
	type OwnerProfileInput
} from '$lib/server/services/owner-profile';
import { assertSettingWrite, settingAccess } from '$lib/server/settings/tiers';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import {
	HERO_FIELDS,
	type HeroCopy,
	type HeroDefaults,
	type HeroField
} from '$lib/config/home-hero';

/**
 * Profile & Preferences: the owner's public persona. Only the pointer owner may
 * edit; an admin sees the same values read-only. `email` is read from the auth user
 * and never written here; `bio` has no public surface yet and is deliberately
 * absent.
 */
export const load: PageServerLoad = async (event) => {
	await requireAdminRole();
	const [view, home, siteDefaultLang, langRow] = await Promise.all([
		loadOwnerEditorView(),
		loadHomeHero(),
		getOption('site.default_lang'),
		db.query.user.findFirst({
			where: eq(user.id, event.locals.user?.id ?? ''),
			columns: { defaultLang: true }
		})
	]);
	const admin = event.locals.admin;
	const access = settingAccess(admin?.role, 'profile');
	const heroCopy: HeroCopy = {
		title: home.title ?? {},
		subtitlePrefix: home.subtitlePrefix ?? {},
		subtitleHighlight: home.subtitleHighlight ?? {},
		description: home.description ?? {},
		welcome: home.welcome ?? {}
	};
	return {
		view,
		editable: Boolean(
			access.editable && admin?.role === 'owner' && view.pointerUserId === admin.userId
		),
		hero: {
			copy: heroCopy,
			// Built-in copy per locale; "copy default" and the effective
			// preview use this when an override is absent.
			defaults: heroDefaults(view.profile?.displayName ?? ''),
			siteDefaultLang,
			locales: [...OPTION_LANGS],
			updatedAt: home.updatedAt?.toISOString() ?? null
		},
		// Content language: a per-user preference lives here, not in the
		// security-only Account page. Empty = follow the site default.
		defaultLang: langRow?.defaultLang ?? null,
		siteDefaultLang,
		langs: [...OPTION_LANGS]
	};
};

function heroDefaults(name: string): HeroDefaults {
	const defaults = {} as HeroDefaults;
	for (const locale of OPTION_LANGS) {
		defaults[locale] = {
			title: m.hero_title({ name }, { locale }),
			subtitlePrefix: m.hero_subtitle_prefix({}, { locale }),
			subtitleHighlight: m.hero_subtitle_highlight({}, { locale }),
			description: m.hero_description({}, { locale }),
			welcome: m.hero_welcome({}, { locale })
		};
	}
	return defaults;
}

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
	},

	/**
	 * Home hero copy. Every field is a per-locale map; an empty input removes that
	 * locale's override, so the field falls back to the site default language and then
	 * to the built-in copy.
	 */
	saveHero: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'profile', 'profile.home_hero');

		const form = await event.request.formData();
		const input: HomeHeroInput = {};
		for (const field of HERO_FIELDS) {
			const map: Record<string, string> = {};
			for (const locale of OPTION_LANGS) {
				const value = form.get(`hero.${field}.${locale}`);
				if (typeof value === 'string') map[locale] = value;
			}
			input[field as HeroField] = map;
		}

		try {
			const saved = await saveHomeHero(input, {
				actorId: event.locals.user?.id ?? ''
			});
			return {
				step: 'hero' as const,
				ok: true,
				hero: saved,
				message: m.admin_settings_profile_hero_saved()
			};
		} catch (caught) {
			if (caught instanceof OwnerProfileError) {
				return fail(caught.status, {
					message: caught.message,
					step: 'hero' as const,
					ok: false
				});
			}
			console.warn(
				'[settings] home hero save failed:',
				caught instanceof Error ? caught.message : caught
			);
			return fail(500, {
				message: m.admin_settings_profile_hero_err_save(),
				step: 'hero' as const,
				ok: false
			});
		}
	},

	/**
	 * Content language: the language new content starts in. Stored on the signed-in
	 * user only; empty means "follow site.default_lang" and is stored as NULL, so a
	 * later site-default change still reaches this author.
	 */
	contentLang: async (event) => {
		await requireAdminRole();
		assertSettingWrite(event.locals.admin?.role, 'profile', 'profile.content_language');

		const form = await event.request.formData();
		const lang = (form.get('lang') ?? '').toString();

		if (lang !== '' && !(OPTION_LANGS as readonly string[]).includes(lang)) {
			return fail(400, {
				message: m.admin_settings_profile_err_content_lang(),
				step: 'contentLang' as const,
				ok: false
			});
		}

		await db
			.update(user)
			.set({ defaultLang: lang || null })
			.where(eq(user.id, event.locals.user?.id ?? ''));

		return {
			message: m.admin_settings_profile_msg_content_lang(),
			step: 'contentLang' as const,
			ok: true
		};
	}
};

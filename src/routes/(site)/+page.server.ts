import { getLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { getOption, OPTION_LANGS } from '$lib/server/config/options-registry';
import { loadHomeHero } from '$lib/server/services/owner-profile';
import { resolveHeroCopy, type HeroCopy, type HeroDefaults } from '$lib/config/home-hero';
import type { PageServerLoad } from './$types';

/**
 * Homepage read path (D3/Q12/W4.5): one read of the `home_hero` singleton,
 * resolved for the request locale. Owner identity and social links come from
 * the site chrome via `parent()` — the homepage never re-queries the profile
 * and never writes (no lazy repair, no default-row creation).
 */
export const load: PageServerLoad = async ({ parent }) => {
	const [{ siteOwner, ownerLinks }, home, siteDefaultLang] = await Promise.all([
		parent(),
		loadHomeHero(),
		getOption('site.default_lang')
	]);

	const copy: HeroCopy = {
		title: home.title ?? {},
		subtitlePrefix: home.subtitlePrefix ?? {},
		subtitleHighlight: home.subtitleHighlight ?? {},
		description: home.description ?? {},
		welcome: home.welcome ?? {}
	};
	const name = siteOwner.name;
	const label = siteOwner.headerLabel?.trim() || name;
	const locale = getLocale();

	return {
		owner: siteOwner,
		ownerLinks: ownerLinks ?? [],
		hero: resolveHeroCopy(copy, locale, siteDefaultLang, heroDefaults(name), { name, label }),
		heroLocale: locale
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

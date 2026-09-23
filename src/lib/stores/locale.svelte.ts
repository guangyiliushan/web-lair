import { setLocale, locales } from '$lib/paraglide/runtime';

type LocaleTag = (typeof locales)[number];

export const localeLabels: Record<string, string> = {
	en: 'English',
	'zh-cn': '简体中文',
	ja: '日本語'
};

/**
 * The one place the UI switches locale.
 *
 * The preference lives in paraglide's cookie (`PARAGLIDE_LOCALE`): `setLocale`
 * writes it and reloads, so the server renders the next page in the new locale
 * and `<html lang>` follows. A second copy in localStorage used to live here
 * and was re-applied on every boot; once `getLocale()` was pinned client-side
 * the two could never agree, so that re-application reloaded forever. The
 * cookie is the single source of truth now.
 */
class LocaleStore {
	get available(): readonly string[] {
		return locales;
	}

	switchTo(locale: string): void {
		if (!locales.includes(locale as LocaleTag)) return;
		setLocale(locale as LocaleTag);
	}
}

export const localeStore = new LocaleStore();

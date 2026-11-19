import { setLocale, locales } from '$lib/paraglide/runtime';

type LocaleTag = (typeof locales)[number];

export const localeLabels: Record<string, string> = {
	en: 'English',
	'zh-cn': '简体中文',
	ja: '日本語'
};

/**
 * Same names, tagged for option lists (`简体中文 (zh-cn)`).
 *
 * Locale names are endonyms — data, not UI copy — so they deliberately live
 * here instead of the message catalog: `日本語` must not turn into "Japanese"
 * just because the admin is rendered in English. Language pickers spell a
 * language the same way whatever the surrounding chrome says.
 */
export const localeOptionLabels: Record<string, string> = Object.fromEntries(
	Object.entries(localeLabels).map(([code, name]) => [code, `${name} (${code})`])
);

/**
 * The one place the UI switches locale.
 *
 * The preference lives in paraglide's cookie (`PARAGLIDE_LOCALE`): `setLocale`
 * writes it and reloads, so the server renders the next page in the new locale
 * and `<html lang>` follows. A second copy in localStorage must not be added:
 * with `getLocale()` pinned client-side the two sources could never agree, so
 * the page reloaded forever. The cookie is the single source of truth now.
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

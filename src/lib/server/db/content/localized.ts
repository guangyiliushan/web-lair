// Localized jsonb column shapes shared across content tables (pages / photos).
// Kept free of table imports so columns can reuse the shapes without reverse
// imports between schema modules (review follow-up: photo -> page).

export type PageLocale = 'en' | 'zh-cn' | 'ja';

/** Database shape only; the service layer guarantees a usable locale. */
export type LocalizedText = Partial<Record<PageLocale, string>>;
export type LocalizedMarkdown = Partial<Record<PageLocale, string>>;

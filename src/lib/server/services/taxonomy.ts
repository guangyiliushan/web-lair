import type { LocalizedText } from '$lib/server/db/content';
import { resolveLocalized } from '$lib/server/services/pages';
import { SLUG_RE } from './posts';

/**
 * Taxonomy label resolution.
 *
 * `name` IS the source-language label; `name_i18n` holds the other locales
 * and (by DB CHECK) never the source one. The order matters: reusing
 * `resolveLocalized` would let `en` outrank the source for a zh reader when
 * only the English label exists.
 */
export const TAXONOMY_LOCALES = ['en', 'zh-cn', 'ja'] as const;

export interface TaxonomyLabel {
	name: string;
	nameI18n?: LocalizedText | null;
	sourceLang: string;
}

export function nonEmpty(value: string | null | undefined): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** URL shape for category/topic slugs (single, ASCII, hyphen-separated). */
export function isValidTaxonomySlug(slug: string): boolean {
	return SLUG_RE.test(slug);
}

export function resolveTaxonomyName(row: TaxonomyLabel, locale: string): string {
	// Reuse the house display-field chain: seeding the source label under its
	// own locale makes `resolveLocalized` produce exactly the taxonomy order
	// (locale -> en -> localeOrder), with the source reader short-circuiting.
	return resolveLocalized({ ...row.nameI18n, [row.sourceLang]: row.name }, locale) ?? row.name;
}

export function resolveTaxonomyDescription(
	description: string | null | undefined,
	descriptionI18n: LocalizedText | null | undefined,
	sourceLang: string,
	locale: string
): string | null {
	const source = nonEmpty(description);
	if (source === null) {
		return resolveLocalized(descriptionI18n, locale);
	}
	return resolveLocalized({ ...descriptionI18n, [sourceLang]: source }, locale) ?? source;
}

/** Number of locales carrying a label (source included) — admin list badge. */
export function taxonomyCompleteness(row: TaxonomyLabel): number {
	const present = new Set<string>();
	if ((TAXONOMY_LOCALES as readonly string[]).includes(row.sourceLang)) present.add(row.sourceLang);
	for (const locale of TAXONOMY_LOCALES) {
		if (nonEmpty(row.nameI18n?.[locale])) present.add(locale);
	}
	return present.size;
}

/**
 * Form -> jsonb for the write side. The source locale is never written into
 * `name_i18n` (the DB CHECK would reject it); a blank field drops the key so
 * clearing an input removes the translation instead of storing "".
 */
export function parseTaxonomyI18n(
	form: FormData,
	field: 'name' | 'description',
	sourceLang: string
): LocalizedText {
	const out: LocalizedText = {};
	for (const locale of TAXONOMY_LOCALES) {
		if (locale === sourceLang) continue;
		const value = form.get(`${field}_${locale}`)?.toString().trim() ?? '';
		if (value !== '') out[locale] = value;
	}
	return out;
}

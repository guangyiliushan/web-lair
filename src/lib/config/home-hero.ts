/**
 * Home hero copy resolution.
 *
 * Each field is a per-locale override map. Resolution order:
 *   requested locale -> site default language -> built-in messages -> ''.
 * Overrides may contain `{name}` / `{label}` tokens; they are rendered as
 * plain text (never HTML). An empty string in a map means "no override".
 */
export const HERO_FIELDS = [
	'title',
	'subtitlePrefix',
	'subtitleHighlight',
	'description',
	'welcome'
] as const;

export type HeroField = (typeof HERO_FIELDS)[number];

export const HERO_FIELD_MAX: Record<HeroField, number> = {
	title: 120,
	subtitlePrefix: 120,
	subtitleHighlight: 120,
	description: 300,
	welcome: 120
};

export type LocaleCopy = Record<string, string>;
export type HeroCopy = Record<HeroField, LocaleCopy>;
export type HeroDefaults = Record<string, Record<HeroField, string>>;

export type HeroSource = 'override' | 'site_default' | 'default';

export interface ResolvedHeroField {
	value: string;
	source: HeroSource;
}

export interface HeroTokens {
	name: string;
	label: string;
}

export function renderHeroTokens(text: string, tokens: HeroTokens): string {
	return text.replaceAll('{name}', tokens.name).replaceAll('{label}', tokens.label);
}

/** True when a locale map carries at least one non-empty override. */
export function hasHeroOverride(copy: LocaleCopy | null | undefined): boolean {
	if (!copy) return false;
	return Object.values(copy).some((value) => typeof value === 'string' && value.trim() !== '');
}

export function resolveHeroField(
	overrides: LocaleCopy | null | undefined,
	field: HeroField,
	locale: string,
	siteDefaultLang: string,
	defaults: HeroDefaults,
	tokens: HeroTokens
): ResolvedHeroField {
	const own = overrides?.[locale];
	if (typeof own === 'string' && own.trim() !== '') {
		return { value: renderHeroTokens(own, tokens), source: 'override' };
	}
	if (locale !== siteDefaultLang) {
		const site = overrides?.[siteDefaultLang];
		if (typeof site === 'string' && site.trim() !== '') {
			return { value: renderHeroTokens(site, tokens), source: 'site_default' };
		}
	}
	const fallback = defaults[locale]?.[field] || defaults[siteDefaultLang]?.[field] || '';
	return { value: renderHeroTokens(fallback, tokens), source: 'default' };
}

/** Resolve all five fields for one request locale (homepage read path). */
export function resolveHeroCopy(
	copy: HeroCopy,
	locale: string,
	siteDefaultLang: string,
	defaults: HeroDefaults,
	tokens: HeroTokens
): Record<HeroField, string> {
	const resolved = {} as Record<HeroField, string>;
	for (const field of HERO_FIELDS) {
		resolved[field] = resolveHeroField(
			copy[field],
			field,
			locale,
			siteDefaultLang,
			defaults,
			tokens
		).value;
	}
	return resolved;
}

/** Empty map means "all fields fall back"; used for the singleton default row. */
export function emptyHeroCopy(): HeroCopy {
	return {
		title: {},
		subtitlePrefix: {},
		subtitleHighlight: {},
		description: {},
		welcome: {}
	};
}

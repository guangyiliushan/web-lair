import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { locales } from '$lib/paraglide/runtime';
import { db } from '$lib/server/db';
import {
	pages,
	type LocalizedMarkdown,
	type LocalizedText,
	type PageLocale
} from '$lib/server/db/content';

export type PageRow = typeof pages.$inferSelect;

/** Chrome projection for the menu/footer loaders (no body payload). */
export type ChromePageRow = Pick<PageRow, 'slug' | 'title' | 'icon' | 'externalUrl' | 'isDefault'>;

/** Sitemap projection: body presence + the lastmod signal. */
export type SitemapPageRow = Pick<PageRow, 'slug' | 'content' | 'updatedAt'>;

const localeOrder = locales as readonly string[];

/**
 * Display-field fallback chain (pages plan §2.4 / ledger §19.9, 2026-10-03):
 * current → en → any, in the fixed locale order. Titles and descriptions only
 * - body content is served strictly (see {@link resolvePageContent}). Blank
 * strings count as missing.
 */
export function resolveLocalized(
	value: LocalizedText | LocalizedMarkdown | null | undefined,
	locale: string
): string | null {
	if (!value) return null;
	const seen = new Set<string>();
	for (const candidate of [locale, 'en', ...localeOrder]) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		const text = value[candidate as PageLocale];
		if (typeof text === 'string' && text.trim().length > 0) return text;
	}
	return null;
}

/**
 * Strict body resolution for md rows (2026-10-03 ruling): the CURRENT locale
 * only. Missing → null, and the universal route turns that into a 404 with
 * the available-languages hint - the body never silently falls back.
 */
export function resolvePageContent(
	content: LocalizedMarkdown | null | undefined,
	locale: string
): string | null {
	const text = content?.[locale as PageLocale];
	return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

/**
 * Locales that actually carry body content, in the fixed order - the single
 * source for the missing-language hint, hreflang alternates and sitemap
 * inclusion (never re-derive this elsewhere).
 */
export function contentLocales(content: LocalizedMarkdown | null | undefined): PageLocale[] {
	if (!content) return [];
	return localeOrder.filter((candidate) => {
		const text = content[candidate as PageLocale];
		return typeof text === 'string' && text.trim().length > 0;
	}) as PageLocale[];
}

/** Neutral href: external rows target their URL, other rows the registry path. */
export function pageHref(row: Pick<PageRow, 'slug' | 'externalUrl'>): string {
	return row.externalUrl ?? `/${row.slug}`;
}

/**
 * Chrome order (pages plan §3.1): every visible row, `is_default` first, then
 * `sort_order`, then `created_at`. Row-level visibility only (V1 ruling
 * 2026-10-03) - language availability is owned by the route, not this query.
 */
export async function listVisiblePages(): Promise<ChromePageRow[]> {
	return db
		.select({
			slug: pages.slug,
			title: pages.title,
			icon: pages.icon,
			externalUrl: pages.externalUrl,
			isDefault: pages.isDefault
		})
		.from(pages)
		.where(eq(pages.status, 'visible'))
		.orderBy(desc(pages.isDefault), asc(pages.sortOrder), asc(pages.createdAt));
}

/**
 * Sitemap source (2026-10-03 ruling): visible ∧ site-internal ∧ carrying body
 * content - rows whose route provably serves a 200. Hidden rows stay out (the
 * menu-hidden semantics are not advertised); code rows join in their own
 * route batches. Slug order keeps the feed bytes stable (P3-b ETag contract).
 */
export async function listSitemapPages(): Promise<SitemapPageRow[]> {
	const rows = await db
		.select({ slug: pages.slug, content: pages.content, updatedAt: pages.updatedAt })
		.from(pages)
		.where(and(eq(pages.status, 'visible'), isNotNull(pages.content), isNull(pages.externalUrl)))
		.orderBy(asc(pages.slug));
	return rows.filter((row) => contentLocales(row.content).length > 0);
}

/** Universal-route fetch: ANY status (hidden rows stay directly reachable). */
export async function getPageBySlug(slug: string): Promise<PageRow | null> {
	const rows = await db.select().from(pages).where(eq(pages.slug, slug)).limit(1);
	return rows[0] ?? null;
}

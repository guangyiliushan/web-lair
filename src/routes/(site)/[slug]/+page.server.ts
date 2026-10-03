import { error } from '@sveltejs/kit';
import { getLocale, localizeHref, locales } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import {
	contentLocales,
	getPageBySlug,
	resolveLocalized,
	resolvePageContent
} from '$lib/server/services/pages';
import type { PageServerLoad } from './$types';

/**
 * Universal md-page route (pages line P1b; 2026-10-03 rulings). Any-status
 * rows serve their body STRICTLY in the current locale: a missing language is
 * a 404 with a hint listing the locales that do carry content - never a
 * silent fallback (mirror of the posts/notes language contract). External
 * rows and rows without body content are plain 404s here; code rows live on
 * their own file routes, which rank above this dynamic segment. `hidden` rows
 * stay directly reachable - hiding is a menu-level concern.
 */
export const load: PageServerLoad = async ({ params }) => {
	const lang = getLocale();
	const row = await getPageBySlug(params.slug);

	if (!row || row.externalUrl !== null || !row.content) {
		error(404, 'Not found');
	}

	const contentLangs = contentLocales(row.content);
	const body = resolvePageContent(row.content, lang);

	if (body === null) {
		// The hint keeps its meaning only while some locale carries content; an
		// empty content object falls through to a plain 404 (nothing to offer).
		if (contentLangs.length === 0) {
			error(404, 'Not found');
		}
		error(404, {
			message: m.error_page_language_hint(),
			available: contentLangs.map((tag) => ({
				lang: tag,
				href: localizeHref(`/${row.slug}`, { locale: tag as (typeof locales)[number] })
			}))
		});
	}

	const html = await renderMarkdownToHtml(body);
	const title = resolveLocalized(row.title, lang) ?? row.slug;
	const description = resolveLocalized(row.description, lang);

	// hreflang set: the locales that carry content, same path per locale, self
	// included (x-default stays deferred; ruling 2026-10-03).
	const alternates = contentLangs.map((tag) => ({
		lang: tag,
		path: `/${row.slug}`
	}));

	return {
		seo: { path: `/${row.slug}`, alternates },
		page: { slug: row.slug, title, description },
		html
	};
};

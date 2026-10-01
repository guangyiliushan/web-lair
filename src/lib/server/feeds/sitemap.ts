import { escapeXml } from './xml';

export interface SitemapAlternate {
	hreflang: string;
	/** Absolute URL of that language's version. */
	href: string;
}

export interface SitemapUrl {
	/** Absolute canonical URL. */
	loc: string;
	/** W3C Datetime (ISO 8601) — omit when there is no reliable signal. */
	lastmod?: string;
	/** Published alternates, self included (xhtml:link). */
	alternates?: SitemapAlternate[];
}

export interface SitemapOptions {
	urls: SitemapUrl[];
}

/**
 * sitemaps.org 0.9 urlset (single file — ledger §22): no changefreq/priority
 * (Google ignores them), lastmod only from a real updated_at signal.
 */
export function buildSitemap(options: SitemapOptions): string {
	const entries = options.urls.map(buildUrl).join('\n');
	return (
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
			entries,
			'</urlset>'
		].join('\n') + '\n'
	);
}

function buildUrl(url: SitemapUrl): string {
	const lines = ['\t<url>', `\t\t<loc>${escapeXml(url.loc)}</loc>`];
	if (url.lastmod !== undefined) lines.push(`\t\t<lastmod>${url.lastmod}</lastmod>`);
	for (const alternate of url.alternates ?? []) {
		lines.push(
			`\t\t<xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.href)}" />`
		);
	}
	lines.push('\t</url>');
	return lines.join('\n');
}

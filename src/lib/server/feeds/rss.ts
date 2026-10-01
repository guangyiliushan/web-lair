import { cdata, escapeXml } from './xml';

export interface RssItem {
	title: string;
	/** Absolute canonical URL of the item. */
	link: string;
	/** Stable identifier (`urn:uuid:<id>`) — survives slug changes. */
	guid: string;
	pubDate: Date;
	/** Plain-text summary. */
	description: string;
	/** Full HTML body, wrapped in CDATA (content:encoded). */
	contentHtml?: string;
}

export interface RssFeedOptions {
	/** Locale tag (en | zh-cn | ja) — channel <language>. */
	lang: string;
	title: string;
	description: string;
	/** Human-facing channel URL. */
	link: string;
	/** Absolute URL of this feed (atom:link rel=self). */
	selfHref: string;
	lastBuildDate: Date;
	items: RssItem[];
}

/**
 * RSS 2.0 channel with atom:link self and content:encoded items (P3-b,
 * ledger §22). Hand-rolled on purpose: the W3C Feed Validator is the gate,
 * not a runtime dependency.
 */
export function buildRssFeed(options: RssFeedOptions): string {
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
		'\t<channel>',
		`\t\t<title>${escapeXml(options.title)}</title>`,
		`\t\t<link>${escapeXml(options.link)}</link>`,
		`\t\t<description>${escapeXml(options.description)}</description>`,
		`\t\t<language>${escapeXml(options.lang)}</language>`,
		`\t\t<lastBuildDate>${options.lastBuildDate.toUTCString()}</lastBuildDate>`,
		`\t\t<atom:link href="${escapeXml(options.selfHref)}" rel="self" type="application/rss+xml" />`,
		...options.items.map(buildItem),
		'\t</channel>',
		'</rss>'
	];
	return `${lines.join('\n')}\n`;
}

function buildItem(item: RssItem): string {
	const lines = [
		'\t\t<item>',
		`\t\t\t<title>${escapeXml(item.title)}</title>`,
		`\t\t\t<link>${escapeXml(item.link)}</link>`,
		`\t\t\t<guid isPermaLink="false">${escapeXml(item.guid)}</guid>`,
		`\t\t\t<pubDate>${item.pubDate.toUTCString()}</pubDate>`,
		`\t\t\t<description>${escapeXml(item.description)}</description>`
	];
	if (item.contentHtml !== undefined) {
		lines.push(`\t\t\t<content:encoded>${cdata(item.contentHtml)}</content:encoded>`);
	}
	lines.push('\t\t</item>');
	return lines.join('\n');
}

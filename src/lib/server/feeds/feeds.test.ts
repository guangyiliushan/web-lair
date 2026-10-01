import { describe, expect, it } from 'vitest';
import { buildRssFeed, buildSitemap, cdata, escapeXml, sanitizeXmlText } from './index';

describe('escapeXml', () => {
	it('escapes the five XML entities for text and attributes', () => {
		expect(escapeXml(`a & b < c > "d" 'e'`)).toBe(
			'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;'
		);
	});
});

describe('cdata', () => {
	it('wraps payloads and splits a nested terminator', () => {
		expect(cdata('<p>hi</p>')).toBe('<![CDATA[<p>hi</p>]]>');
		expect(cdata('a ]]> b')).toBe('<![CDATA[a ]]]]><![CDATA[> b]]>');
	});
});

describe('sanitizeXmlText', () => {
	it('strips characters XML 1.0 cannot represent, in text and CDATA alike', () => {
		// A form-feed pasted from a PDF used to make the whole feed
		// non-well-formed (review finding).
		expect(sanitizeXmlText('a\u0001b\u000Cc')).toBe('abc');
		expect(escapeXml('a\u0000b & c')).toBe('ab &amp; c');
		expect(cdata('<p>a\u000Bb</p>')).toBe('<![CDATA[<p>ab</p>]]>');
	});

	it('keeps the characters XML 1.0 allows (tabs, newlines, astral planes)', () => {
		expect(sanitizeXmlText('keep\ttab\nnewline\rCR')).toBe('keep\ttab\nnewline\rCR');
		expect(sanitizeXmlText('emoji \ud83c\udf89 ok')).toBe('emoji \ud83c\udf89 ok');
	});
});

describe('buildRssFeed', () => {
	it('serialises the channel with atom:link self and content:encoded items', () => {
		const feed = buildRssFeed({
			lang: 'en',
			title: 'Lair & Co',
			description: 'Latest',
			link: 'https://example.com/en/posts',
			selfHref: 'https://example.com/en/rss.xml',
			lastBuildDate: new Date('2026-09-30T12:00:00Z'),
			items: [
				{
					title: 'Hello <world>',
					link: 'https://example.com/en/posts/hello',
					guid: 'urn:uuid:019bfc4e-0000-7000-8000-000000000001',
					pubDate: new Date('2026-09-30T09:00:00Z'),
					description: 'Summary',
					contentHtml: '<p>Body</p>'
				}
			]
		});

		expect(feed).toContain('<title>Lair &amp; Co</title>');
		expect(feed).toContain(
			'<atom:link href="https://example.com/en/rss.xml" rel="self" type="application/rss+xml" />'
		);
		expect(feed).toContain(
			'<guid isPermaLink="false">urn:uuid:019bfc4e-0000-7000-8000-000000000001</guid>'
		);
		expect(feed).toContain('<pubDate>Wed, 30 Sep 2026 09:00:00 GMT</pubDate>');
		expect(feed).toContain('<title>Hello &lt;world&gt;</title>');
		expect(feed).toContain('<content:encoded><![CDATA[<p>Body</p>]]></content:encoded>');
	});

	it('emits a valid empty channel without items', () => {
		const feed = buildRssFeed({
			lang: 'zh-cn',
			title: 'Lair',
			description: 'Latest',
			link: 'https://example.com/zh-cn/posts',
			selfHref: 'https://example.com/zh-cn/rss.xml',
			items: []
		});

		expect(feed).toContain('<language>zh-cn</language>');
		expect(feed).not.toContain('<item>');
		expect(feed.trimEnd().endsWith('</rss>')).toBe(true);
		// No reliable change signal in an empty feed: lastBuildDate stays out.
		expect(feed).not.toContain('<lastBuildDate>');
	});
});

describe('buildSitemap', () => {
	it('serialises urls with lastmod and xhtml alternates, no changefreq/priority', () => {
		const sitemap = buildSitemap({
			urls: [
				{ loc: 'https://example.com/en/' },
				{
					loc: 'https://example.com/en/posts/a',
					lastmod: '2026-09-30T09:00:00.000Z',
					alternates: [
						{ hreflang: 'en', href: 'https://example.com/en/posts/a' },
						{ hreflang: 'zh-cn', href: 'https://example.com/zh-cn/posts/a-zh' }
					]
				}
			]
		});

		expect(sitemap).toContain(
			'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
		);
		expect(sitemap).toContain('<loc>https://example.com/en/posts/a</loc>');
		expect(sitemap).toContain('<lastmod>2026-09-30T09:00:00.000Z</lastmod>');
		expect(sitemap).toContain(
			'<xhtml:link rel="alternate" hreflang="zh-cn" href="https://example.com/zh-cn/posts/a-zh" />'
		);
		expect(sitemap).not.toContain('changefreq');
		expect(sitemap).not.toContain('<priority>');
		// The home entry carries no lastmod (no reliable signal).
		expect(sitemap).toContain('<url>\n\t\t<loc>https://example.com/en/</loc>\n\t</url>');
	});

	it('escapes locations and alternates', () => {
		const sitemap = buildSitemap({
			urls: [{ loc: 'https://example.com/en/posts/a?x=1&y=2' }]
		});
		expect(sitemap).toContain('<loc>https://example.com/en/posts/a?x=1&amp;y=2</loc>');
	});

	it('escapes lastmod like every other interpolated value', () => {
		const sitemap = buildSitemap({
			urls: [{ loc: 'https://example.com/en/', lastmod: 'a<b&"c"' }]
		});
		expect(sitemap).toContain('<lastmod>a&lt;b&amp;&quot;c&quot;</lastmod>');
	});
});

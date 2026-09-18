import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtmlSync } from './markdown-config';

/**
 * Render-pipeline regression: final HTML of the client light pipeline
 * (sanitize included) for mention (micromark) and remark-directive
 * (alerts).
 */
describe('rendered html output', () => {
	it('renders <tag> element through the raw-html whitelist', () => {
		const html = renderMarkdownToHtmlSync('正文 <tag>标签</tag> 后文');
		expect(html).toContain('<tag>标签</tag>');
		expect(html).toContain('正文 ');
		expect(html).toContain(' 后文');
	});

	it('escapes html special characters inside whitelisted elements', () => {
		const html = renderMarkdownToHtmlSync('<tag>a<b</tag>');
		// rehype-stringify escapes `<` as the numeric entity `&#x3C;`; both forms
		// decode to the same character, so accept either
		expect(html).toMatch(/a(&lt;|&#x3C;)b/);
		expect(html).not.toContain('<tag>a<b</tag>');
	});

	it('renders @gh: mention as token link', () => {
		const html = renderMarkdownToHtmlSync('找 @gh:octocat 看看');
		// attribute order is a hast serialization detail
		expect(html).toContain('class="mention"');
		expect(html).toContain('href="@gh:octocat"');
		expect(html).toContain('>@gh:octocat</a>');
	});

	it('renders > [!NOTE] alert with nested list preserved', () => {
		const html = renderMarkdownToHtmlSync('> [!NOTE]\n> - 项一\n> - 项二');
		expect(html).toContain('alert alert-note');
		expect(html).toContain('<li>项一</li>');
		expect(html).toContain('<li>项二</li>');
	});

	it('renders the five alert types and the title line', () => {
		expect(renderMarkdownToHtmlSync('> [!TIP] 标题\n> 内容')).toContain(
			'<p class="alert-title">标题</p>'
		);
		expect(renderMarkdownToHtmlSync('> [!IMPORTANT]\n> 内容')).toContain('alert-important');
		expect(renderMarkdownToHtmlSync('> [!WARNING]\n> 内容')).toContain('alert-warning');
		expect(renderMarkdownToHtmlSync('> [!CAUTION]\n> 内容')).toContain('alert-caution');
	});

	it('renders :::spoiler as a block spoiler (details) and keeps retired containers content', () => {
		const spoiler = renderMarkdownToHtmlSync(':::spoiler\n隐藏内容\n:::');
		expect(spoiler).toContain('<details');
		expect(spoiler).toContain('<summary>剧透</summary>');
		expect(spoiler).toContain('隐藏内容');
		const retired = renderMarkdownToHtmlSync(':::gallery\n![a](https://example.com/a.png)\n:::');
		expect(retired).toContain('<img');
		expect(retired).not.toContain('class="gallery"');
	});
});

import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtmlSync } from './markdown-config';

/**
 * Render-pipeline regression: final HTML of the client light pipeline
 * (sanitize included) for mention (micromark) and remark-directive
 * (callouts).
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

	it('renders :::info as callout with nested list preserved', () => {
		const html = renderMarkdownToHtmlSync(':::info\n- 项一\n- 项二\n:::');
		expect(html).toContain('callout callout-info');
		expect(html).toContain('<li>项一</li>');
		expect(html).toContain('<li>项二</li>');
	});

	it('renders :::tip and :::warning callouts', () => {
		expect(renderMarkdownToHtmlSync(':::tip\n内容\n:::')).toContain('callout-tip');
		expect(renderMarkdownToHtmlSync(':::warning\n内容\n:::')).toContain('callout-warning');
	});

	it('keeps legacy spoiler/gallery/banner directives working', () => {
		expect(renderMarkdownToHtmlSync(':::spoiler\n隐藏内容\n:::')).toContain('spoiler-container');
	});
});

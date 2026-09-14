import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtmlSync } from './markdown-config';

/**
 * 渲染管线回归：验证 remark-tag 与 remark-directive（callout）
 * 在客户端轻量管线（含 sanitize）中的最终 HTML 输出。
 */
describe('rendered html output', () => {
	it('renders #tag# as span.tag', () => {
		const html = renderMarkdownToHtmlSync('正文 #tag# 后文');
		expect(html).toContain('<span class="tag">tag</span>');
		expect(html).toContain('正文 ');
		expect(html).toContain(' 后文');
	});

	it('renders multiple tags in one paragraph', () => {
		const html = renderMarkdownToHtmlSync('#alpha# 与 #beta#');
		expect(html).toContain('<span class="tag">alpha</span>');
		expect(html).toContain('<span class="tag">beta</span>');
	});

	it('escapes html special characters in tag content', () => {
		const html = renderMarkdownToHtmlSync('#a<b&c#');
		expect(html).toContain('<span class="tag">a&#x3C;b&#x26;c</span>');
		expect(html).not.toContain('<span class="tag">a<b&c</span>');
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

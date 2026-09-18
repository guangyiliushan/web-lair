import { afterEach, expect, it, vi } from 'vitest';
import { renderMarkdownToHtmlSync } from '$lib/components/markdown/editor/markdown-config';

afterEach(() => {
	vi.restoreAllMocks();
});

it('warns once per unknown container name and keeps its content', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	renderMarkdownToHtmlSync(':::whatever\n内容\n:::');
	renderMarkdownToHtmlSync(':::whatever\n内容\n:::');
	expect(warn).toHaveBeenCalledTimes(1);
	expect(String(warn.mock.calls[0]?.[0])).toContain('whatever');
});

it('warns for unknown grid parameters and out-of-range values, once per cause', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	renderMarkdownToHtmlSync(':::grid{cols=99 bogus=9}\n内容\n:::');
	renderMarkdownToHtmlSync(':::grid{cols=99 bogus=9}\n内容\n:::');
	const messages = warn.mock.calls.map((call) => String(call[0]));
	expect(messages.some((message) => message.includes('cols=99'))).toBe(true);
	expect(messages.some((message) => message.includes('bogus'))).toBe(true);
	expect(warn).toHaveBeenCalledTimes(2);
});

it('warns for unknown keys on details while keeping the content', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const html = renderMarkdownToHtmlSync(':::details{label="x"}\n内容\n:::');
	expect(html).toContain('内容');
	expect(warn.mock.calls.some((call) => String(call[0]).includes('label'))).toBe(true);
});

it('warns when tabs contains a non-tab block and renders it in place', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const html = renderMarkdownToHtmlSync(':::tabs\n散落内容\n:::');
	expect(html).toContain('散落内容');
	expect(warn.mock.calls.some((call) => String(call[0]).includes('tabs'))).toBe(true);
});

it('warns when a tab is used outside tabs and keeps the content', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const html = renderMarkdownToHtmlSync(':::tab{label="x"}\n面板\n:::');
	expect(html).toContain('面板');
	expect(warn.mock.calls.some((call) => String(call[0]).includes('only valid inside'))).toBe(true);
});

it('warns for unknown keys on tab containers', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	const html = renderMarkdownToHtmlSync('::::tabs\n:::tab{label="x" bogus="1"}\n面板\n:::\n::::');
	expect(html).toContain('面板');
	expect(warn.mock.calls.some((call) => String(call[0]).includes('bogus'))).toBe(true);
});

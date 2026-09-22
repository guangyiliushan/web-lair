import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

/**
 * Link magnet (batch 3a): publish-side inline links get a data-magnet stamp
 * and --mx/--my coordinates on hover; embed-card links are excluded; the
 * effect never mutates text layout (the stamp only feeds absolute
 * pseudo-elements).
 */

const MD_WITH_LINKS = [
	'访问 [Svelte 官网](https://svelte.dev) 与 [文档](https://developer.mozilla.org) 了解更多。',
	'![example-org/example-repo](https://github.com/example-org/example-repo)'
].join('\n\n');

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
});

describe('link magnet', () => {
	it('stamps the hovered http link and tracks pointer coordinates', async () => {
		await page.viewport(1280, 720);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
		const host = document.createElement('div');
		document.body.appendChild(host);
		const instance = mount(MarkdownRenderer, { target: host, props: { source: MD_WITH_LINKS } });
		try {
			await expect
				.poll(() => document.querySelectorAll('.markdown-body a[href^="http"]').length, {
					timeout: 5000
				})
				.toBeGreaterThanOrEqual(3);

			const link = document.querySelector(
				'.markdown-body a[href="https://svelte.dev"]'
			) as HTMLAnchorElement;
			const rect = link.getBoundingClientRect();
			link.dispatchEvent(
				new MouseEvent('mousemove', {
					bubbles: true,
					clientX: rect.left + 10,
					clientY: rect.top + 5
				})
			);
			// rAF 一帧后变量落盘
			await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
			expect(link.hasAttribute('data-magnet')).toBe(true);
			// 坐标跟随鼠标(容差 ±2px:iframe 布局 settle 会引起亚像素漂移)
			const mx = parseFloat(link.style.getPropertyValue('--mx'));
			const my = parseFloat(link.style.getPropertyValue('--my'));
			expect(Math.abs(mx - 10)).toBeLessThanOrEqual(2);
			expect(Math.abs(my - 5)).toBeLessThanOrEqual(2);

			// 同容器另一个链接:印章转移,旧的清除
			const other = document.querySelector(
				'.markdown-body a[href="https://developer.mozilla.org"]'
			) as HTMLAnchorElement;
			const rect2 = other.getBoundingClientRect();
			other.dispatchEvent(
				new MouseEvent('mousemove', {
					bubbles: true,
					clientX: rect2.left + 1,
					clientY: rect2.top + 1
				})
			);
			await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
			expect(other.hasAttribute('data-magnet')).toBe(true);
			expect(link.hasAttribute('data-magnet')).toBe(false);
		} finally {
			unmount(instance, { outro: false });
		}
	});

	it('never stamps links inside embed cards', async () => {
		await page.viewport(1280, 720);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
		const host = document.createElement('div');
		document.body.appendChild(host);
		const instance = mount(MarkdownRenderer, { target: host, props: { source: MD_WITH_LINKS } });
		try {
			await expect
				.poll(() => document.querySelectorAll('.embed-card-mount').length, { timeout: 5000 })
				.toBeGreaterThan(0);
			const cardLink = document.querySelector('.embed-card-mount .embed-link') as HTMLAnchorElement;
			const rect = cardLink.getBoundingClientRect();
			cardLink.dispatchEvent(
				new MouseEvent('mousemove', {
					bubbles: true,
					clientX: rect.left + 5,
					clientY: rect.top + 5
				})
			);
			await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
			expect(cardLink.hasAttribute('data-magnet')).toBe(false);
		} finally {
			unmount(instance, { outro: false });
		}
	});

	it('clears the stamp when the pointer leaves the container', async () => {
		await page.viewport(1280, 720);
		const host = document.createElement('div');
		document.body.appendChild(host);
		const instance = mount(MarkdownRenderer, { target: host, props: { source: MD_WITH_LINKS } });
		try {
			await expect
				.poll(() => document.querySelectorAll('.markdown-body a[href^="http"]').length, {
					timeout: 5000
				})
				.toBeGreaterThanOrEqual(2);
			const article = document.querySelector('.markdown-body') as HTMLElement;
			const link = document.querySelector(
				'.markdown-body a[href="https://svelte.dev"]'
			) as HTMLAnchorElement;
			const rect = link.getBoundingClientRect();
			link.dispatchEvent(
				new MouseEvent('mousemove', {
					bubbles: true,
					clientX: rect.left + 3,
					clientY: rect.top + 3
				})
			);
			await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
			expect(link.hasAttribute('data-magnet')).toBe(true);

			article.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
			expect(link.hasAttribute('data-magnet')).toBe(false);
		} finally {
			unmount(instance, { outro: false });
		}
	});
});

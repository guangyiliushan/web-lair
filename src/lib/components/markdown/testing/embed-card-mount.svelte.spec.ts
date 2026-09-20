import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';
import LifecycleFixture from '$lib/components/markdown/testing/embed-lifecycle-fixture.svelte';

// Browser-project spec: mounts the real Svelte component (not a raw HTML
// string) so the client-side enhancement layer is exercised end to end —
// placeholder anchors must be upgraded to card components, facades must not
// create any iframe before a click (spec 6 / 7).

async function mountRenderer(source: string): Promise<HTMLElement> {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const instance = mount(MarkdownRenderer, { target: host, props: { source } });
	// The mounting effect runs onMount; give the microtask queue a beat.
	await new Promise((resolve) => setTimeout(resolve, 0));
	// Keep the instance alive for the assertions; teardown happens per test.
	unmountFns.push(() => unmount(instance));
	return host;
}

const unmountFns: Array<() => void> = [];

afterEach(() => {
	while (unmountFns.length > 0) unmountFns.pop()!();
});

describe('embed card mounting (spec 3.4/7)', () => {
	it('upgrades the placeholder anchor to a card component', async () => {
		const host = await mountRenderer('![repo](https://github.com/foo/bar)');
		try {
			const card = host.querySelector('.embed-card-mount');
			expect(card, 'card component must be mounted over the anchor').not.toBeNull();
			expect(host.querySelector('a.embed-card')).toBeNull();
			expect(card!.textContent).toContain('repo');
			const link = card!.querySelector('a');
			expect(link?.getAttribute('href')).toBe('https://github.com/foo/bar');
			expect(link?.getAttribute('rel')).toContain('noopener');
		} finally {
			unmountFns.pop()?.();
		}
	});

	it('does not create an iframe before a facade click', async () => {
		const host = await mountRenderer('![video](https://youtu.be/dQw4w9WgXcQ)');
		try {
			expect(host.querySelector('.embed-card-mount')).not.toBeNull();
			expect(host.querySelector('iframe')).toBeNull();
			const loadButton = host.querySelector('button.embed-load') as HTMLButtonElement | null;
			expect(loadButton, 'a facade must offer an explicit click-to-load control').not.toBeNull();
			loadButton!.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			const iframe = host.querySelector('iframe');
			expect(iframe).not.toBeNull();
			expect(iframe!.getAttribute('src')).toContain('youtube.com/embed/dQw4w9WgXcQ');
			expect(iframe!.getAttribute('sandbox')).toContain('allow-scripts');
		} finally {
			unmountFns.pop()?.();
		}
	});

	it('keeps generic cards free of iframes and favicon fetches', async () => {
		const host = await mountRenderer('![站点](https://unknown.example/page)');
		try {
			expect(host.querySelector('.embed-card-mount')).not.toBeNull();
			expect(host.querySelector('iframe')).toBeNull();
			// generic cards never contact the favicon proxy (spec 6)
			expect(host.querySelector('img[src*="/api/favicon"]')).toBeNull();
		} finally {
			unmountFns.pop()?.();
		}
	});

	it('re-enhances after the source changes (live preview)', async () => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const instance = mount(LifecycleFixture, {
			target: host,
			props: {
				initial: '![a](https://github.com/foo/bar)',
				next: '![b](https://github.com/foo/baz)'
			}
		});
		unmountFns.push(() => unmount(instance));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.querySelectorAll('.embed-card-mount')).toHaveLength(1);
		(host.querySelector('[data-swap]') as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(host.querySelectorAll('.embed-card-mount')).toHaveLength(1);
		expect(host.querySelector('.embed-link')?.getAttribute('href')).toBe(
			'https://github.com/foo/baz'
		);
	});

	it('routes provider favicons through the proxy and drops broken ones', async () => {
		const host = await mountRenderer('![repo](https://github.com/foo/bar)');
		const favicon = host.querySelector('img.embed-favicon') as HTMLImageElement;
		expect(favicon.getAttribute('src')).toMatch(/^\/api\/favicon\?url=/);
		expect(favicon.getAttribute('src')).toContain(encodeURIComponent('https://github.com'));
		expect(favicon.getAttribute('referrerpolicy')).toBe('no-referrer');
		favicon.dispatchEvent(new Event('error'));
		expect(host.querySelector('img.embed-favicon')).toBeNull();
	});

	it('gives generic cards a default glyph and no favicon request', async () => {
		const host = await mountRenderer('![x](https://example.com/some/page)');
		expect(host.querySelector('img.embed-favicon')).toBeNull();
		expect(host.querySelector('svg.embed-favicon-default')).not.toBeNull();
	});
});

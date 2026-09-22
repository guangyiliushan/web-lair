import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

/**
 * Rich-link enrichment (batch 2c): the four core GitHub cards progressively
 * upgrade from metadata served by /api/embed-meta; every failure mode keeps
 * the static card, and every non-GitHub provider stays zero-request.
 */

const REPO_MD = '![example-org/example-repo](https://github.com/example-org/example-repo)';
const COMMIT_MD =
	'![commit](https://github.com/example-org/example-repo/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0)';

function mountRenderer(source: string): { destroy: () => void } {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const instance = mount(MarkdownRenderer, { target: host, props: { source } });
	return { destroy: () => unmount(instance, { outro: false }) ?? host.remove() };
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = '';
});

describe('embed card github enrichment', () => {
	it('upgrades a repo card with description, stars and the language tint', async () => {
		await page.viewport(1280, 720);
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				kind: 'repo',
				title: 'example-org/example-repo',
				description: 'An example repository used in tests',
				stars: 82000,
				language: 'JavaScript',
				avatarUrl: 'https://avatars.githubusercontent.com/u/23617959',
				htmlUrl: 'https://github.com/example-org/example-repo'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const renderer = mountRenderer(REPO_MD);
		try {
			await expect
				.poll(() => document.querySelectorAll('.embed-card-mount.embed-enriched').length, {
					timeout: 5000
				})
				.toBeGreaterThan(0);

			const card = document.querySelector('.embed-enriched') as HTMLElement;
			expect(card.querySelector('.embed-desc')?.textContent).toContain('An example repository');
			expect([...card.querySelectorAll('.embed-chip')].map((c) => c.textContent)).toContain(
				'★ 82,000'
			);
			const dot = card.querySelector('.embed-lang-dot') as HTMLElement;
			// browsers normalise the hex to rgb() in the style attribute
			expect(dot.getAttribute('style')).toContain('rgb(241, 224, 90)');
			expect(card.querySelector('.embed-tint')).toBeTruthy();
			expect(card.querySelector('.embed-avatar')).toBeTruthy();
			expect(fetchMock).toHaveBeenCalledOnce();
		} finally {
			renderer.destroy();
		}
	});

	it('shows +N/-N, the short sha and the avatar on commit cards', async () => {
		await page.viewport(1280, 720);
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					kind: 'commit',
					title: 'fix: example commit subject (#1234)',
					additions: 9,
					deletions: 10,
					sha: 'a1b2c3d',
					avatarUrl: 'https://avatars.githubusercontent.com/u/40380293',
					repoName: 'example-org/example-repo'
				})
			)
		);
		const renderer = mountRenderer(COMMIT_MD);
		try {
			await expect
				.poll(() => document.querySelectorAll('.embed-card-mount.embed-enriched').length, {
					timeout: 5000
				})
				.toBeGreaterThan(0);
			const chips = [...document.querySelectorAll('.embed-enriched .embed-chip')].map((c) =>
				c.textContent.trim()
			);
			expect(chips).toContain('+9');
			expect(chips).toContain('-10');
			expect(chips).toContain('a1b2c3d');
			expect(chips).toContain('example-org/example-repo');
			expect(document.querySelector('.embed-enriched .embed-title')?.textContent).toContain(
				'fix: example commit'
			);
		} finally {
			renderer.destroy();
		}
	});

	it('keeps the static card when the proxy answers 204 (rate limit / not found)', async () => {
		await page.viewport(1280, 720);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
		const renderer = mountRenderer(REPO_MD);
		try {
			// the card itself mounts immediately (placeholder → component)
			await expect
				.poll(() => document.querySelectorAll('.embed-card-mount').length, { timeout: 5000 })
				.toBeGreaterThan(0);
			await new Promise((r) => setTimeout(r, 300));
			expect(document.querySelectorAll('.embed-enriched').length).toBe(0);
			expect(document.querySelector('.embed-card-mount .embed-title')?.textContent).toContain(
				'example-org/example-repo'
			);
		} finally {
			renderer.destroy();
		}
	});

	it('never fetches metadata for non-GitHub providers (zero-request contract)', async () => {
		await page.viewport(1280, 720);
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const renderer = mountRenderer('![paper](https://arxiv.org/abs/1703.03762)');
		try {
			await expect
				.poll(() => document.querySelectorAll('.embed-card-mount').length, { timeout: 5000 })
				.toBeGreaterThan(0);
			await new Promise((r) => setTimeout(r, 200));
			expect(fetchMock).not.toHaveBeenCalled();
			expect(document.querySelectorAll('.embed-enriched').length).toBe(0);
		} finally {
			renderer.destroy();
		}
	});
});

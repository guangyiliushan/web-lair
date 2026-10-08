import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

/**
 * Client-side coverage for the public projects grid (P review follow-up):
 * the empty copy, the list/listitem semantics and the card contract are
 * pinned here at the component level, so the e2e empty-state case (which
 * needs a globally empty live database) can retire gracefully once real
 * published rows exist. Mounting mirrors embed-card-mount.svelte.spec.ts.
 */
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL('http://localhost:4173/zh-cn/projects');
		},
		get data() {
			return {};
		}
	}
}));

// Pin the UI locale for deterministic copy (official paraglide escape hatch).
overwriteGetLocale(() => 'zh-cn');

import ProjectsPage from './+page.svelte';

let rowSeq = 0;
const row = (overrides: Record<string, unknown>) => ({
	// The grid keys each card by row.id (loader contract).
	id: `grid-row-${++rowSeq}`,
	name: 'row',
	description: null,
	provider: 'github',
	projectUrl: 'https://example.com/',
	previewUrl: null,
	docUrl: null,
	avatar: null,
	language: null,
	stars: null,
	pushedLabel: null,
	archived: false,
	...overrides
});

const unmountFns: Array<() => void> = [];

async function mountGrid(rows: Promise<unknown[]>) {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const instance = mount(ProjectsPage, {
		target: host,
		props: { data: { rows } } as never
	});
	// The await block resolves on the microtask queue; give it a beat.
	await new Promise((resolve) => setTimeout(resolve, 0));
	unmountFns.push(() => unmount(instance));
	return host;
}

afterEach(() => {
	while (unmountFns.length > 0) unmountFns.pop()!();
	document.head
		.querySelectorAll('link[rel="canonical"], link[rel="alternate"]')
		.forEach((element) => element.remove());
});

describe('public projects grid', () => {
	it('renders the empty copy when no row is published', async () => {
		const host = await mountGrid(Promise.resolve([]));
		expect(host.textContent).toContain('还没有项目。');
	});

	it('pins the list semantics and the card contract', async () => {
		const host = await mountGrid(
			Promise.resolve([
				row({
					name: '格状仓库',
					provider: 'github',
					projectUrl: 'https://github.com/o/r',
					previewUrl: 'https://preview.example/',
					language: 'TypeScript',
					stars: 42,
					archived: true
				}),
				row({
					name: '格状网站',
					provider: 'site',
					projectUrl: 'https://site.example/',
					docUrl: 'https://docs.example/'
				}),
				row({ name: '格状不安全', provider: 'other', projectUrl: null })
			])
		);

		expect(host.querySelectorAll('[role="list"]')).toHaveLength(1);
		const cards = host.querySelectorAll<HTMLElement>('[role="listitem"]');
		expect(cards).toHaveLength(3);

		// Repo card: stretched link with rel/target, status row with the
		// sr-only stars label, archived badge, preview exit only.
		const repo = cards[0]!;
		const repoLink = repo.querySelector('a');
		expect(repoLink?.getAttribute('href')).toBe('https://github.com/o/r');
		expect(repoLink?.getAttribute('target')).toBe('_blank');
		expect(repoLink?.getAttribute('rel')).toContain('noopener noreferrer');
		expect(repo.textContent).toContain('GitHub');
		expect(repo.textContent).toContain('TypeScript');
		expect(repo.textContent).toContain('42');
		expect(repo.textContent).toContain('星标');
		expect(repo.textContent).toContain('已归档');
		expect(repo.querySelector('a[href="https://preview.example/"]')).not.toBeNull();
		expect(repo.querySelector('a[href="https://docs.example/"]')).toBeNull();

		// Site card: badge and docs exit.
		const site = cards[1]!;
		expect(site.textContent).toContain('网站');
		expect(site.querySelector('a[href="https://docs.example/"]')).not.toBeNull();

		// Unsafe URL (nulled by the loader): name renders without any link.
		const unsafe = cards[2]!;
		expect(unsafe.textContent).toContain('格状不安全');
		expect(unsafe.querySelector('a')).toBeNull();
		expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
	});
});

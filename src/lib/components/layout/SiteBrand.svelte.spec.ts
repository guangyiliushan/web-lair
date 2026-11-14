import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import SiteBrand from './SiteBrand.svelte';
import type { OwnerPresence } from '$lib/config/owner-presence';

overwriteGetLocale(() => 'en');

const unknown: OwnerPresence = {
	state: 'unknown',
	activity: null,
	app: null,
	updatedAt: null,
	lastSeenAt: null
};

function brandLink(): HTMLAnchorElement | null {
	return document.querySelector('a[title]');
}

describe('SiteBrand (Q6)', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('shows the compact label but keeps the full name in aria/title', async () => {
		await render(SiteBrand, {
			owner: { name: 'guangyiliushan', avatar: '', headerLabel: 'shan' },
			presence: unknown
		});

		expect(document.body.textContent).toContain('shan');
		expect(document.body.textContent).not.toContain('guangyiliushan');
		expect(brandLink()?.getAttribute('aria-label')).toBe('guangyiliushan');
		expect(brandLink()?.getAttribute('title')).toBe('guangyiliushan');
	});

	it('falls back to the full name when no label is set', async () => {
		await render(SiteBrand, {
			owner: { name: 'mikoto', avatar: '', headerLabel: null },
			presence: unknown
		});

		expect(document.body.textContent).toContain('mikoto');
		expect(brandLink()?.getAttribute('aria-label')).toBe('mikoto');
	});
});

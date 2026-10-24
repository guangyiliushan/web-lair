import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import OwnerStatusHoverCard from './OwnerStatusHoverCard.svelte';
import type { OwnerPresence } from '$lib/config/owner-presence';

overwriteGetLocale(() => 'en');

const online: OwnerPresence = {
	state: 'online',
	activity: 'coding',
	app: { name: 'Visual Studio Code', icon: '' },
	updatedAt: null,
	lastSeenAt: null
};

const offline: OwnerPresence = {
	...online,
	state: 'offline'
};

const unknown: OwnerPresence = {
	state: 'unknown',
	activity: null,
	app: null,
	updatedAt: null,
	lastSeenAt: null
};

function trigger(): Element | null {
	return document.querySelector('[data-slot="owner-status-trigger"]');
}

function card(): Element | null {
	return document.querySelector('[data-slot="owner-status-card"]');
}

describe('owner status header', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the short-name online shape with an app icon and card', async () => {
		await render(OwnerStatusHoverCard, {
			ownerName: 'Lair',
			presence: online,
			open: true
		});

		expect(trigger()).not.toBeNull();
		expect(trigger()?.querySelector('[data-slot="owner-status-dot"]')).not.toBeNull();
		expect(trigger()?.querySelector('[data-slot="owner-status-app-icon"]')).not.toBeNull();
		expect(card()?.textContent).toContain('Visual Studio Code');
		expect(card()?.textContent).toContain('Using');
	});

	it('drops the inline app icon for long owner names', async () => {
		await render(OwnerStatusHoverCard, {
			ownerName: 'guangyiliushan',
			presence: online,
			open: true
		});

		expect(trigger()).not.toBeNull();
		expect(trigger()?.querySelector('[data-slot="owner-status-app-icon"]')).toBeNull();
		expect(trigger()?.querySelector('[data-slot="owner-status-app-name"]')).toBeNull();
		expect(card()?.textContent).toContain('Visual Studio Code');
	});

	it('hides the dot offline but keeps the muted last-used icon', async () => {
		await render(OwnerStatusHoverCard, {
			ownerName: 'Lair',
			presence: offline,
			open: true
		});

		expect(trigger()).not.toBeNull();
		expect(trigger()?.querySelector('[data-slot="owner-status-dot"]')).toBeNull();
		expect(trigger()?.querySelector('[data-slot="owner-status-app-icon"]')?.className).toContain(
			'grayscale'
		);
		expect(card()?.textContent).toContain('Last used');
	});

	it('renders nothing when the status surface is disabled', async () => {
		await render(OwnerStatusHoverCard, {
			ownerName: 'Lair',
			presence: unknown,
			enabled: false,
			open: true
		});

		expect(trigger()).toBeNull();
		expect(card()).toBeNull();
	});
});

import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { SITE_OWNER_DEFAULT } from '$lib/config/owner-status';
import type { OwnerPresence } from '$lib/config/owner-presence';
import NavMenuProfile from './NavMenuProfile.svelte';

// Pin the UI locale for the light's accessible name.
overwriteGetLocale(() => 'zh-cn');

const stats = [{ label: '文章', value: 2 }];

const online: OwnerPresence = {
	state: 'online',
	activity: 'coding',
	app: { name: 'VS Code', icon: '' },
	updatedAt: null,
	lastSeenAt: null
};

const unknown: OwnerPresence = {
	state: 'unknown',
	activity: null,
	app: null,
	updatedAt: null,
	lastSeenAt: null
};

/** The light is the only `role="img"` in the identity row. */
function onlineLight(): Element | null {
	return document.body.querySelector('[role="img"]');
}

describe('NavMenuProfile identity row', () => {
	it('shows only the owner name when presence is unknown (no fake online)', async () => {
		await render(NavMenuProfile, {
			owner: SITE_OWNER_DEFAULT,
			presence: unknown,
			stats,
			links: []
		});

		expect(document.body.textContent).toContain(SITE_OWNER_DEFAULT.name);
		expect(onlineLight()).toBeNull();
		// The header owns the avatar and the activity ticket; the panel must not
		// echo either of them.
		expect(document.body.querySelector('img')).toBeNull();
		expect(document.body.querySelector('[data-slot="owner-status"]')).toBeNull();
	});

	it('shows the light only for a real online heartbeat', async () => {
		await render(NavMenuProfile, {
			owner: SITE_OWNER_DEFAULT,
			presence: online,
			stats,
			links: []
		});

		expect(onlineLight()?.getAttribute('aria-label')).toBe(m.nav_home_owner_online());
	});

	it('drops the light while the owner is offline', async () => {
		await render(NavMenuProfile, {
			owner: SITE_OWNER_DEFAULT,
			presence: { ...unknown, state: 'offline' },
			stats,
			links: []
		});

		expect(onlineLight()).toBeNull();
	});
});

import { render } from 'vitest-browser-svelte';
import { describe, expect, it } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { OWNER_STATUS_DEFAULT, SITE_OWNER_DEFAULT } from '$lib/config/owner-status';
import NavMenuProfile from './NavMenuProfile.svelte';

// Pin the UI locale for the light's accessible name.
overwriteGetLocale(() => 'zh-cn');

const stats = [{ label: '文章', value: 2 }];

/** The light is the only `role="img"` in the identity row. */
function onlineLight(): Element | null {
	return document.body.querySelector('[role="img"]');
}

describe('NavMenuProfile identity row', () => {
	it('shows only the owner name plus the online light', async () => {
		await render(NavMenuProfile, {
			owner: SITE_OWNER_DEFAULT,
			status: OWNER_STATUS_DEFAULT,
			stats,
			social: []
		});

		expect(document.body.textContent).toContain(SITE_OWNER_DEFAULT.name);
		expect(onlineLight()?.getAttribute('aria-label')).toBe(m.nav_home_owner_online());
		// The header owns the avatar and the activity ticket; the panel must not
		// echo either of them (P1b review round).
		expect(document.body.querySelector('img')).toBeNull();
		expect(document.body.querySelector('[data-slot="owner-status"]')).toBeNull();
	});

	it('drops the light while the owner is away', async () => {
		await render(NavMenuProfile, {
			owner: SITE_OWNER_DEFAULT,
			status: { ...OWNER_STATUS_DEFAULT, kind: 'idle' },
			stats,
			social: []
		});

		expect(document.body.textContent).toContain(SITE_OWNER_DEFAULT.name);
		expect(onlineLight()).toBeNull();
	});

	it('drops the light when the status ticket is disabled', async () => {
		await render(NavMenuProfile, {
			owner: SITE_OWNER_DEFAULT,
			status: { ...OWNER_STATUS_DEFAULT, enabled: false },
			stats,
			social: []
		});

		expect(document.body.textContent).toContain(SITE_OWNER_DEFAULT.name);
		expect(onlineLight()).toBeNull();
	});
});

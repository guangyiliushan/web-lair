import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NAV_ICON_NAMES, navIcon } from './nav-icons';

describe('nav icon whitelist', () => {
	it('ships a curated set whose icons all exist in the installed package', () => {
		expect(NAV_ICON_NAMES.length).toBeGreaterThanOrEqual(20);
		for (const name of NAV_ICON_NAMES) {
			expect(existsSync(`node_modules/@tabler/icons-svelte-runes/dist/icons/${name}.svelte`)).toBe(
				true
			);
		}
	});

	it('resolves known names and rejects unknown or absent ones', () => {
		expect(navIcon('notebook')).toBeTruthy();
		expect(navIcon('plane')).toBeTruthy();
		expect(navIcon('no-such-icon')).toBeNull();
		expect(navIcon(null)).toBeNull();
		expect(navIcon(undefined)).toBeNull();
	});
});

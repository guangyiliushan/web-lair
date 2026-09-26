import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks so the module under test can be imported statically: the old
// TDZ-driven dynamic import also paid the Svelte compile cost inside a hook,
// which then needed a growing timeout under load (P1.1 review).
const { mockSetLocale, lsGetItem, lsSetItem } = vi.hoisted(() => ({
	mockSetLocale: vi.fn(),
	lsGetItem: vi.fn(),
	lsSetItem: vi.fn()
}));

vi.mock('$lib/paraglide/runtime', () => ({
	setLocale: mockSetLocale,
	locales: ['en', 'zh-cn', 'ja']
}));

vi.stubGlobal('window', { localStorage: { getItem: lsGetItem, setItem: lsSetItem } });

import { localeStore } from './locale.svelte';

describe('LocaleStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('exposes all available locales', () => {
		expect(localeStore.available).toEqual(['en', 'zh-cn', 'ja']);
	});

	it('hands a valid switch to paraglide (which writes the cookie and reloads)', () => {
		localeStore.switchTo('ja');
		expect(mockSetLocale).toHaveBeenCalledTimes(1);
		expect(mockSetLocale).toHaveBeenCalledWith('ja');
	});

	it('rejects invalid locale values', () => {
		localeStore.switchTo('fr');
		expect(mockSetLocale).not.toHaveBeenCalled();
	});

	// Teeth for the single source of truth: the cookie (written by paraglide)
	// is the preference. A second copy in localStorage is what used to disagree
	// with the resolved locale and reload forever - so both the write side and
	// the (removed) read side must stay untouched.
	it('keeps no second copy of the preference', () => {
		localeStore.switchTo('ja');
		expect(lsSetItem).not.toHaveBeenCalled();
		expect(lsGetItem).not.toHaveBeenCalled();
	});
});

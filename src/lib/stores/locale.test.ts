import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockSetLocale = vi.fn();
const mockAvailableTags: string[] = ['en', 'zh-cn', 'ja'];

vi.mock('$lib/paraglide/runtime', () => ({
	setLocale: mockSetLocale,
	locales: mockAvailableTags
}));

const lsSetItem = vi.fn();
vi.stubGlobal('window', { localStorage: { getItem: vi.fn(), setItem: lsSetItem } });

let localeStore: {
	available: readonly string[];
	switchTo(l: string): void;
};

// The dynamic import of the Svelte module compiles it in-flight; idle this
// file runs in ~1.1s, but under a loaded suite run the hook has exceeded 30s
// (measured 2026-09-22 while four parallel vitest instances ran). Give the
// hook generous room so the gate stays deterministic under load.
beforeAll(async () => {
	const mod = await import('./locale.svelte');
	localeStore = mod.localeStore;
}, 60_000);

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
	// with the resolved locale and reload forever.
	it('keeps no second copy of the preference', () => {
		localeStore.switchTo('ja');
		expect(lsSetItem).not.toHaveBeenCalled();
	});
});

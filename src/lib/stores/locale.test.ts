import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockSetLocale = vi.fn();
const mockGetLocale = vi.fn(() => 'en');
const mockAvailableTags: string[] = ['en', 'zh-cn', 'ja'];

vi.mock('$lib/paraglide/runtime', () => ({
	setLocale: mockSetLocale,
	getLocale: mockGetLocale,
	locales: mockAvailableTags
}));

const store: Record<string, string> = {};
const lsMock = {
	getItem: vi.fn((key: string) => store[key] ?? null),
	setItem: vi.fn((key: string, value: string) => {
		store[key] = value;
	}),
	clear: vi.fn(() => {
		Object.keys(store).forEach((k) => delete store[k]);
	})
};

beforeAll(() => {
	vi.stubGlobal('window', { localStorage: lsMock });
});

let localeStore: {
	current: string;
	available: readonly string[];
	switchTo(l: string): void;
	init(): void;
};

// The dynamic import of the Svelte module can exceed the 10s default hook
// timeout while the whole suite runs in parallel; give this hook room so the
// gate stays deterministic under load.
beforeAll(async () => {
	const mod = await import('./locale.svelte');
	localeStore = mod.localeStore;
}, 30_000);

describe('LocaleStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		lsMock.clear();
		mockGetLocale.mockReturnValue('en');
	});

	it('reports current locale from paraglide', () => {
		mockGetLocale.mockReturnValue('zh-cn');
		expect(localeStore.current).toBe('zh-cn');
	});

	it('exposes all available locales', () => {
		expect(localeStore.available).toEqual(['en', 'zh-cn', 'ja']);
	});

	it('persists locale to localStorage on switch', () => {
		localeStore.init();
		localeStore.switchTo('ja');
		expect(mockSetLocale).toHaveBeenCalledWith('ja');
		expect(lsMock.setItem).toHaveBeenCalledWith('locale', 'ja');
	});

	it('rejects invalid locale values', () => {
		mockSetLocale.mockClear();
		localeStore.switchTo('fr');
		expect(mockSetLocale).not.toHaveBeenCalled();
	});

	it('does not restore when stored equals current', () => {
		mockSetLocale.mockClear();
		lsMock.setItem('locale', 'en');
		mockGetLocale.mockReturnValue('en');
		localeStore.init();
		expect(mockSetLocale).not.toHaveBeenCalled();
	});

	it('does not restore when stored locale is invalid', () => {
		mockSetLocale.mockClear();
		lsMock.setItem('locale', 'fr');
		mockGetLocale.mockReturnValue('en');
		localeStore.init();
		expect(mockSetLocale).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Writer-language resolver tests (post-creation flow, task A3): the account
 * value wins only when it is a real site language, otherwise the site default
 * applies, and a corrupt site option falls back to the paraglide base locale.
 * The db module is mocked with the same FIFO `selectQueue` the draft-flow
 * tests use - the real `OPTION_LANGS` stays in place so the allow-list under
 * test is the production one.
 */
const { dbMock, state } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		selectCalls: 0,
		siteLang: 'en' as string
	}
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/config/options-registry', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/config/options-registry')>();
	return { ...actual, getOption: async () => state.siteLang };
});

import { baseLocale } from '$lib/paraglide/runtime';
import { resolveWriterLang } from './writer-lang';

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return () => self;
			}
		}
	);
	return self;
}

beforeEach(() => {
	state.selectQueue = [];
	state.selectCalls = 0;
	state.siteLang = 'en';
	dbMock.select = vi.fn(() => {
		state.selectCalls += 1;
		return makeChain(state.selectQueue.shift() ?? []);
	});
});

describe('resolveWriterLang', () => {
	it('prefers a valid account language over the site default', async () => {
		state.selectQueue.push([{ defaultLang: 'ja' }]);
		state.siteLang = 'en';
		await expect(resolveWriterLang('user-1')).resolves.toBe('ja');
		expect(state.selectCalls).toBe(1);
	});

	it('ignores an account language outside the site set', async () => {
		state.selectQueue.push([{ defaultLang: 'fr' }]);
		state.siteLang = 'zh-cn';
		await expect(resolveWriterLang('user-1')).resolves.toBe('zh-cn');
	});

	it('skips the lookup entirely for a signed-out author', async () => {
		state.siteLang = 'zh-cn';
		await expect(resolveWriterLang(null)).resolves.toBe('zh-cn');
		expect(state.selectCalls).toBe(0);
	});

	it('falls back to the base locale when the site option is corrupt', async () => {
		// Also covers a missing user row: the queue stays empty.
		state.siteLang = 'fr';
		await expect(resolveWriterLang('user-1')).resolves.toBe(baseLocale);
		expect(baseLocale).toBe('en');
	});
});

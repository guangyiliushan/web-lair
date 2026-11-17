import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Application-flow unit tests. The db seam is a tiny
 * fake that records writes; options and the rate limiter are injected, and
 * `friends.checks.enabled=false` keeps the precheck offline (the network
 * checker has its own suite).
 */
const state = vi.hoisted(() => ({
	options: {} as Record<string, unknown>
}));

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('../config/options-registry.ts', () => ({
	getOption: async (key: string) => state.options[key]
}));

import {
	applyForLink,
	decideApplication,
	matchBlockedHost,
	matchBlockedTld,
	APPLY_LIMITS,
	type ApplyDb
} from './apply';
import type { LinkStatus } from '../../utils/link-meta';

interface Recorded {
	inserted: Record<string, unknown>[];
	updated: Record<string, unknown>[];
}

function fakeDb(existing: { id: string; status: LinkStatus; url: string }[]): {
	db: ApplyDb;
	calls: Recorded;
} {
	const calls: Recorded = { inserted: [], updated: [] };
	const returning = { id: '00000000-0000-7000-8000-000000000001' };
	const tx = {
		execute: async () => undefined,
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => existing
				})
			})
		}),
		insert: () => ({
			values: (value: Record<string, unknown>) => ({
				returning: async () => {
					calls.inserted.push(value);
					return [returning];
				}
			})
		}),
		update: () => ({
			set: (value: Record<string, unknown>) => {
				calls.updated.push(value);
				return {
					where: () => ({
						returning: async () => [returning]
					})
				};
			}
		})
	};
	const db = {
		transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
		select: tx.select,
		insert: tx.insert,
		update: tx.update
	} as unknown as ApplyDb;
	return { db, calls };
}

const baseInput = {
	name: 'Example',
	url: 'https://example.com',
	avatar: '',
	description: 'A personal site',
	email: 'owner@example.com',
	backlinkUrl: 'https://example.com/links',
	consent: true
};

beforeEach(() => {
	state.options = {
		'friends.apply': { enabled: true, allowSubPath: false },
		'friends.checks': {
			enabled: false,
			cadenceHours: 24,
			failStreak: 3,
			backlinkStreak: 2,
			graceDays: 30,
			timeoutMs: 10000,
			concurrency: 2
		},
		'friends.policy': {
			blockedHostSuffixes: ['github.io', 'vercel.app'],
			blockedTlds: ['.tk', '.ml'],
			acceptedBacklinkHosts: [],
			publicBannedList: true
		}
	};
});

const allow = async () => ({ allowed: true });

describe('decideApplication', () => {
	const url = 'https://example.com';

	it('rejects a banned host without touching the banned row on the same URL', () => {
		expect(
			decideApplication([{ id: 'b', status: 'banned', url }], { url, hardBlock: null })
		).toEqual({ kind: 'reject', code: 'banned-domain', write: 'none' });
		expect(
			decideApplication([{ id: 'b', status: 'banned', url: 'https://other.example' }], {
				url,
				hardBlock: null
			})
		).toEqual({ kind: 'reject', code: 'banned-domain', write: 'insert' });
	});

	it('refuses a host that is already pending, approved or outdated', () => {
		for (const status of ['pending', 'approved', 'outdated'] as const) {
			expect(
				decideApplication([{ id: 'x', status, url: 'https://other.example' }], {
					url,
					hardBlock: null
				})
			).toEqual({ kind: 'error', code: 'duplicate' });
		}
	});

	it('revives a rejected row on the same URL instead of inserting a duplicate', () => {
		expect(
			decideApplication([{ id: 'r', status: 'rejected', url }], { url, hardBlock: null })
		).toEqual({ kind: 'accept', write: 'revive' });
		expect(
			decideApplication([{ id: 'r', status: 'rejected', url }], {
				url,
				hardBlock: { code: 'blocked-host', detail: 'github.io' }
			})
		).toEqual({ kind: 'reject', code: 'blocked-host', write: 'revive' });
	});

	it('inserts a new pending row when nothing is registered on the host', () => {
		expect(decideApplication([], { url, hardBlock: null })).toEqual({
			kind: 'accept',
			write: 'insert'
		});
	});
});

describe('hard-gate matchers', () => {
	it('matches a free-host suffix but not a lookalike', () => {
		expect(matchBlockedHost('foo.github.io', ['github.io'])).toBe('github.io');
		expect(matchBlockedHost('github.io', ['github.io'])).toBe('github.io');
		expect(matchBlockedHost('notgithub.io', ['github.io'])).toBeNull();
		expect(matchBlockedHost('foo.example', ['github.io'])).toBeNull();
	});

	it('matches a blocked TLD from either stored spelling', () => {
		expect(matchBlockedTld('foo.tk', ['.tk'])).toBe('.tk');
		expect(matchBlockedTld('foo.tk', ['tk'])).toBe('.tk');
		expect(matchBlockedTld('foo.notk', ['.tk'])).toBeNull();
	});
});

describe('applyForLink', () => {
	it('is closed when friends.apply.enabled is false', async () => {
		state.options['friends.apply'] = {
			enabled: false,
			allowSubPath: false
		};
		const { db, calls } = fakeDb([]);
		expect(await applyForLink(baseInput, { db, rateLimit: allow })).toEqual({
			kind: 'error',
			code: 'disabled'
		});
		expect(calls.inserted).toHaveLength(0);
	});

	it('requires consent before any write', async () => {
		const { db, calls } = fakeDb([]);
		expect(await applyForLink({ ...baseInput, consent: false }, { db, rateLimit: allow })).toEqual({
			kind: 'error',
			code: 'consent-required'
		});
		expect(calls.inserted).toHaveLength(0);
	});

	it('refuses a non-https URL (CHECK 3 keeps stored rows https)', async () => {
		const { db, calls } = fakeDb([]);
		expect(
			await applyForLink({ ...baseInput, url: 'http://example.com' }, { db, rateLimit: allow })
		).toEqual({ kind: 'error', code: 'url-insecure' });
		expect(calls.inserted).toHaveLength(0);
	});

	it('refuses a sub-path homepage when allowSubPath is false', async () => {
		const { db } = fakeDb([]);
		expect(
			await applyForLink(
				{ ...baseInput, url: 'https://example.com/about' },
				{ db, rateLimit: allow }
			)
		).toEqual({ kind: 'error', code: 'url-subpath' });
	});

	it('refuses a bare http avatar', async () => {
		const { db } = fakeDb([]);
		expect(
			await applyForLink(
				{ ...baseInput, avatar: 'http://example.com/a.png' },
				{ db, rateLimit: allow }
			)
		).toEqual({ kind: 'error', code: 'avatar-invalid' });
	});

	it('enforces the name/description ceilings', async () => {
		const { db } = fakeDb([]);
		expect(
			await applyForLink(
				{ ...baseInput, name: 'x'.repeat(APPLY_LIMITS.name + 1) },
				{ db, rateLimit: allow }
			)
		).toEqual({ kind: 'error', code: 'name-too-long' });
		expect(
			await applyForLink(
				{ ...baseInput, description: 'x'.repeat(APPLY_LIMITS.description + 1) },
				{ db, rateLimit: allow }
			)
		).toEqual({ kind: 'error', code: 'description-too-long' });
	});

	it('writes a rejected row for a free host and names the suffix in the reason', async () => {
		const { db, calls } = fakeDb([]);
		const result = await applyForLink(
			{ ...baseInput, name: 'Free', url: 'https://free.github.io' },
			{ db, rateLimit: allow }
		);
		expect(result).toEqual({
			kind: 'rejected',
			id: '00000000-0000-7000-8000-000000000001',
			code: 'blocked-host'
		});
		expect(calls.inserted).toHaveLength(1);
		expect(calls.inserted[0]).toMatchObject({
			name: 'Free',
			host: 'free.github.io',
			status: 'rejected',
			reason: 'auto: blocked-host (github.io)',
			checkEnabled: false
		});
	});

	it('writes a rejected row for a blocked TLD', async () => {
		const { db, calls } = fakeDb([]);
		const result = await applyForLink(
			{ ...baseInput, name: 'FreeTld', url: 'https://site.tk' },
			{ db, rateLimit: allow }
		);
		expect(result).toEqual({
			kind: 'rejected',
			id: '00000000-0000-7000-8000-000000000001',
			code: 'blocked-tld'
		});
		expect(calls.inserted[0]).toMatchObject({ reason: 'auto: blocked-tld (.tk)' });
	});

	it('refuses a banned host without writing', async () => {
		const { db, calls } = fakeDb([{ id: 'b', status: 'banned', url: 'https://example.com' }]);
		expect(await applyForLink(baseInput, { db, rateLimit: allow })).toEqual({
			kind: 'rejected',
			id: null,
			code: 'banned-domain'
		});
		expect(calls.inserted).toHaveLength(0);
	});

	it('refuses a host already awaiting review', async () => {
		const { db, calls } = fakeDb([{ id: 'p', status: 'pending', url: 'https://other.example' }]);
		expect(await applyForLink(baseInput, { db, rateLimit: allow })).toEqual({
			kind: 'error',
			code: 'duplicate'
		});
		expect(calls.inserted).toHaveLength(0);
	});

	it('writes pending and hands the new row to the precheck run service', async () => {
		const { db, calls } = fakeDb([]);
		const precheck = vi.fn().mockResolvedValue({ id: 'run-1', status: 'completed' });
		const result = await applyForLink(baseInput, {
			db,
			rateLimit: allow,
			precheck,
			now: () => new Date('2026-11-09T00:00:00Z')
		});
		expect(result).toEqual({
			kind: 'pending',
			id: '00000000-0000-7000-8000-000000000001'
		});
		expect(calls.inserted[0]).toMatchObject({
			name: 'Example',
			url: 'https://example.com',
			host: 'example.com',
			status: 'pending',
			reason: null,
			reviewedAt: null
		});
		// The parent row is written once; evidence lives in the child table.
		expect(calls.updated).toHaveLength(0);
		expect(precheck).toHaveBeenCalledWith(
			expect.objectContaining({
				trigger: 'application',
				link: expect.objectContaining({
					id: '00000000-0000-7000-8000-000000000001',
					url: 'https://example.com',
					backlinkUrl: 'https://example.com/links'
				})
			})
		);
	});

	it('keeps the accepted application when the precheck write fails', async () => {
		const { db } = fakeDb([]);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const precheck = vi.fn().mockRejectedValue(new Error('db down'));
		const result = await applyForLink(baseInput, { db, rateLimit: allow, precheck });
		warn.mockRestore();
		expect(result).toEqual({
			kind: 'pending',
			id: '00000000-0000-7000-8000-000000000001'
		});
	});

	it('revives a previously rejected row to pending', async () => {
		const { db, calls } = fakeDb([{ id: 'r', status: 'rejected', url: 'https://example.com' }]);
		expect(await applyForLink(baseInput, { db, rateLimit: allow })).toEqual({
			kind: 'pending',
			id: '00000000-0000-7000-8000-000000000001'
		});
		expect(calls.updated[0]).toMatchObject({
			status: 'pending',
			reason: null,
			recentChecks: null,
			checkEnabled: true
		});
	});

	it('returns rate-limited before touching the registry', async () => {
		const { db, calls } = fakeDb([]);
		expect(
			await applyForLink(baseInput, { db, rateLimit: async () => ({ allowed: false }) })
		).toEqual({ kind: 'error', code: 'rate-limited' });
		expect(calls.inserted).toHaveLength(0);
	});
});

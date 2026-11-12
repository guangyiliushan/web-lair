import { describe, expect, it } from 'vitest';
import { policyClaims, type PolicyFacts } from './policy-facts';

const base: PolicyFacts = {
	graceDays: 30,
	failStreak: 3,
	backlinkStreak: 2,
	checksEnabled: true,
	checksScheduled: true,
	pruneScheduled: true,
	allowSubPath: false,
	blockedHostSuffixes: ['github.io'],
	blockedTlds: ['.tk'],
	publicBannedList: true,
	emailRetentionDays: 90
};

describe('public policy claims', () => {
	it('never promises automatic checks when either side is off', () => {
		expect(policyClaims({ ...base, checksEnabled: false }).autoCheck).toBe(false);
		expect(policyClaims({ ...base, checksScheduled: false }).autoCheck).toBe(false);
		expect(policyClaims(base).autoCheck).toBe(true);
	});

	it('never promises automatic deletion without a prune schedule', () => {
		expect(policyClaims({ ...base, pruneScheduled: false }).autoPrune).toBe(false);
		expect(policyClaims({ ...base, checksEnabled: false }).autoPrune).toBe(false);
		expect(policyClaims(base).autoPrune).toBe(true);
	});

	it('drops clauses the configuration makes false', () => {
		expect(policyClaims({ ...base, allowSubPath: true }).homepageOnly).toBe(false);
		expect(policyClaims({ ...base, blockedHostSuffixes: [], blockedTlds: [] }).domainDetail).toBe(
			false
		);
		expect(policyClaims({ ...base, publicBannedList: false }).publicBannedList).toBe(false);
	});

	it('carries the live numbers into the claims', () => {
		expect(
			policyClaims({
				...base,
				failStreak: 5,
				backlinkStreak: 3,
				graceDays: 14,
				emailRetentionDays: 30
			})
		).toMatchObject({
			failStreak: 5,
			backlinkStreak: 3,
			graceDays: 14,
			emailRetentionDays: 30
		});
	});
});

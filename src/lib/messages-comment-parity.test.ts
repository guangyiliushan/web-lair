import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Copy-parity canary for the comment_* message keys (comment P3a): the three
 * locales must stay in lock-step and sorted, so a partial translation or a
 * merge cannot silently drop or duplicate a message (test review finding).
 * Runs from the repo root, where vitest's cwd lives.
 */
const LOCALES = ['en', 'zh-cn', 'ja'] as const;

function commentKeys(locale: string): string[] {
	const parsed = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Record<
		string,
		string
	>;
	return Object.keys(parsed).filter((key) => key.startsWith('comment_'));
}

describe('comment message keys', () => {
	it('are identical, non-empty and sorted across all locales', () => {
		const [base, ...others] = LOCALES.map(commentKeys);
		expect(base.length).toBeGreaterThan(15);
		for (const keys of others) expect(keys).toEqual(base);
		expect(base).toEqual([...base].sort());
		// The server-side actions go through m.*: spot-check the keys they
		// reference so a rename cannot break the mapping unnoticed.
		for (const key of [
			'comment_throttled',
			'comment_verify_hint',
			'comment_error_generic',
			'comment_error_parent',
			'comment_error_unavailable'
		]) {
			expect(base).toContain(key);
		}
	});
});

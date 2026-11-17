import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_EVENT_TYPES } from '../../notifications/events';

/**
 * Producer teeth for `activities_event_check`.
 *
 * The constraint admits exactly one dot
 * (`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`), and a producer literal that breaks it
 * only fails at INSERT time - i.e. after the business write it was supposed to
 * accompany. `ai.usage.purge` did exactly that: 23514 on a ledger it had just
 * wiped. Review cannot see every literal, so this scans the audit write path
 * against the predicate pinned in the baseline.
 *
 * Scope: quoted literals only (single or double). Ternaries and constants are
 * covered because any three-segment quoted string in an audit-path file is an
 * offender regardless of shape; template literals and imported constants are
 * NOT visible here - the durable fix for those is typing `ActivityInput.event`.
 */
const BASELINE = readFileSync(
	fileURLToPath(new URL('../../../../../drizzle/0000_baseline.sql', import.meta.url)),
	'utf8'
);

const CHECK_PATTERN = String.raw`^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$`;

/** The `~ '…'` pattern of the activities event CHECK, as a JS RegExp. */
function eventCheckLiteral(): string {
	const line = BASELINE.split('\n').find((line) =>
		line.includes('CONSTRAINT "activities_event_check" CHECK')
	);
	if (!line) throw new Error('activities_event_check not found in drizzle/0000_baseline.sql');
	const literal = line.match(/~\s*'([^']+)'/)?.[1];
	if (!literal) throw new Error('activities_event_check has no `~` pattern to pin');
	return literal;
}

function eventCheckPattern(): RegExp {
	return new RegExp(eventCheckLiteral());
}

/** Producers only: files that actually write an activity row. */
const EVENT_LITERAL = /(?:^|[^\w"'])event:\s*['"]([^'"]+)['"]/g;
/** Any quoted three-segment string in a writer file: catches ternaries/constants. */
const THREE_SEGMENT_LITERAL =
	/(?:^|[^\w"'])(['"])([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\1/g;
const SOURCE_ROOTS = ['src', 'scripts'];
const SKIP_DIRS = new Set(['node_modules']);

/**
 * `notification_deliveries` is a legitimately multi-dot namespace
 * (`mail.probe.failed`), and the scripts that mention `activities` also write
 * that table (`scripts/verify-jobs-drain.ts` asserts the notification CHECK on
 * real PG). Those literals are notification events, not activity events, so the
 * three-segment scan skips them **by name** — never by file, which would blind
 * the scan to an activity event that happens to live next to one. The roster is
 * pinned in the first test so an emptied exclusion list cannot silently make
 * this scan pass.
 */
const NOTIFICATION_EVENT_NAMES = new Set<string>(NOTIFICATION_EVENT_TYPES);

function sourceFiles(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) sourceFiles(path, files);
			continue;
		}
		if (/\.(ts|svelte)$/.test(path) && !/\.(test|spec)\.ts$/.test(path)) files.push(path);
	}
	return files;
}

describe('activities event name contract', () => {
	it('pins the two-segment CHECK from the baseline', () => {
		// Pin the literal itself: the probes below would also accept a
		// *tightened* predicate, so this must fail when the contract is edited.
		expect(eventCheckLiteral()).toBe(CHECK_PATTERN);
		const pattern = eventCheckPattern();
		expect(pattern.test('ai.usage_purge')).toBe(true);
		expect(pattern.test('job.run')).toBe(true);
		expect(pattern.test('ai.usage.purge')).toBe(false);
		expect(pattern.test('Job.Run')).toBe(false);
		expect(pattern.test('ai.')).toBe(false);
		// The multi-dot exclusion set in the scan below must be real - an
		// emptied roster would make the scan quietly weaker, not red.
		expect(NOTIFICATION_EVENT_NAMES.has('mail.probe.failed')).toBe(true);
		expect(NOTIFICATION_EVENT_NAMES.size).toBeGreaterThan(0);
	});

	// The scan reads the whole `src` + `scripts` tree. A full-suite run on a
	// loaded host has been observed at ~37 s (vitest runs the 373 files in
	// parallel), so the budget is 60 s: this asserts a file scan, not a timing
	// property, and a 30 s ceiling made the full suite flake on wall clock.
	it('every recordActivity event literal satisfies the CHECK (source scan)', () => {
		const pattern = eventCheckPattern();
		const offenders: string[] = [];
		const files = SOURCE_ROOTS.flatMap((root) => sourceFiles(root));
		// Denominator guard: a broken walk (wrong root, renamed extension, a
		// SKIP_DIRS mistake) would scan nothing and report a clean scan. The
		// tree is ~1.2k files today; a floor keeps that failure loud without
		// pinning an exact count that every new file would invalidate.
		expect(files.length).toBeGreaterThan(800);
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			// Only files on the audit write path can produce these literals: the
			// audit writer, and the few direct `activities` writers (the budget
			// alert bypasses recordActivity). An unrelated `event: 'x'` elsewhere
			// in the app is out of scope.
			if (!text.includes('recordActivity') && !text.includes('activities')) continue;
			for (const match of text.matchAll(EVENT_LITERAL)) {
				if (!pattern.test(match[1])) offenders.push(`${file}: ${match[1]}`);
			}
			// A name held in a ternary or a constant is out of `event:` position,
			// so the literal itself is the signal: three segments always violates
			// this CHECK — unless the literal is a registered notification event,
			// which is a different namespace with its own (multi-dot) CHECK.
			for (const match of text.matchAll(THREE_SEGMENT_LITERAL)) {
				if (NOTIFICATION_EVENT_NAMES.has(match[2])) continue;
				offenders.push(`${file}: ${match[2]}`);
			}
		}
		expect(offenders).toEqual([]);
		// The multi-dot exclusion is scoped to the notification roster. If a
		// future notification event adds a third segment, the blind spot grows
		// with it - so the size of the excluded set is pinned here.
		expect([...NOTIFICATION_EVENT_NAMES].filter((name) => name.split('.').length >= 3)).toEqual([
			'mail.probe.failed'
		]);
	}, 60_000);
});

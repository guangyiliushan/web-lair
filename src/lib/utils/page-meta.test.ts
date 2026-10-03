import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { locales } from '$lib/paraglide/runtime';
import { isReservedPageSlug, PAGE_RESERVED_SLUGS } from './page-meta';

/**
 * The reserved list is also the shadow defense for the bare-language roots
 * (P1b review): every configured locale tag must stay reserved so a page slug
 * can never take over `/en`-style paths. The [slug] route carries a second
 * read-side guard for rows that predate the entry.
 */
describe('page reserved slugs', () => {
	it('reserves every configured locale tag', () => {
		for (const tag of locales) {
			expect(PAGE_RESERVED_SLUGS.has(tag), tag).toBe(true);
		}
	});

	it('flags the seeds and system segments, not arbitrary slugs', () => {
		expect(isReservedPageSlug('about')).toBe(true);
		expect(isReservedPageSlug('admin')).toBe(true);
		expect(isReservedPageSlug('sponsor')).toBe(false);
	});

	it('covers every first-level static route segment (drift guard)', () => {
		const segments = firstLevelSegments(join(process.cwd(), 'src', 'routes'));
		for (const segment of segments) {
			expect(
				PAGE_RESERVED_SLUGS.has(segment) || SOFT_WARNED_SEGMENTS.has(segment),
				`route segment not accounted for: ${segment}`
			).toBe(true);
		}
		for (const soft of SOFT_WARNED_SEGMENTS) {
			expect(segments.has(soft), `stale soft-warn entry: ${soft}`).toBe(true);
		}
	});
});

/**
 * Segments whose code route already triggers the `db:verify-pages` shadow
 * warning, so the hard list leaves them alone (v1.44 design). A new
 * first-level route must join the hard list or this set - the drift test
 * above fails otherwise.
 */
const SOFT_WARNED_SEGMENTS: ReadonlySet<string> = new Set([
	'account',
	'friends',
	'notes',
	'posts',
	'projects',
	'says',
	'thinking',
	'timeline'
]);

/**
 * Route directories reachable at the site's first path level: root dirs,
 * transparently descending into `(group)` dirs. Dynamic segments and
 * colocated files are not routes.
 */
function firstLevelSegments(dir: string): Set<string> {
	const segments = new Set<string>();
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;
		if (name.startsWith('+') || name.startsWith('[') || name.startsWith('.')) continue;
		if (name.startsWith('(')) {
			for (const nested of firstLevelSegments(join(dir, name))) segments.add(nested);
			continue;
		}
		segments.add(name);
	}
	return segments;
}

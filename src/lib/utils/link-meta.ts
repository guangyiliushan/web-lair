/**
 * Shared link metadata for the links line (plan §2.7): the single source for
 * the `links.status` values and the checker's error-kind vocabulary.
 *
 * Dependency-free and Node-loadable by design: the SvelteKit app imports it
 * through `$lib`, while the plain-Node jobs side (builtin `links.check`,
 * `scripts/jobs/check-links.ts`) imports it via a relative `.ts` specifier -
 * aliases do not resolve there (jobs-line constraint).
 */
export const LINK_STATUSES = ['pending', 'approved', 'outdated', 'rejected', 'banned'] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/**
 * Checker error vocabulary (plan §4.3): `redirect` joined 2026-10-06 - a
 * redirect chain longer than the 5-hop limit is a hard failure for a crawler
 * by definition (the 3-strike model then decides on `outdated`).
 */
export const LINK_ERROR_KINDS = [
	'dns',
	'connect',
	'tls',
	'timeout',
	'http_gone',
	'http_error',
	'waf',
	'robots',
	'offsite',
	'unsupported',
	'redirect',
	'page_missing',
	'link_missing',
	'ok'
] as const;
export type LinkErrorKind = (typeof LINK_ERROR_KINDS)[number];

/** One evidence entry of the `links.recent_checks` ring (plan §2.4). */
export interface LinkCheck {
	at: string;
	kind: 'precheck' | 'reachability' | 'backlink';
	ok: boolean;
	/** The page actually checked (post-redirect); review round 4. */
	url?: string;
	http?: number;
	err?: LinkErrorKind;
	ms?: number;
	note?: string;
}

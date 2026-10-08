import type { RepoIdentity } from './types.ts';

/**
 * URL -> repository identity for the four synced platforms (plan §T7):
 * `.git` suffixes, trailing slashes, case, sub-paths and query strings all
 * resolve to the same identity; unknown domains resolve to null. Pure and
 * standalone - no fetch, no throw.
 */

/** Path segments under known hosts that are site surfaces, not repositories. */
const RESERVED_FIRST_SEGMENTS = new Set([
	'settings',
	'marketplace',
	'explore',
	'topics',
	'features',
	'about',
	'pricing',
	'sponsors',
	'notifications',
	'issues',
	'pulls',
	'login',
	'signup',
	'logout',
	'session',
	'orgs',
	'users',
	'account',
	'search',
	'dashboard'
]);

interface HostRule {
	provider: RepoIdentity['provider'];
	/** Host(s) accepted for this platform (lowercase, no www). */
	hosts: string[];
	/** Minimum path segments; GitLab allows subgroups (account = all but last). */
	minSegments: number;
	/** Whether the account part may contain multiple segments. */
	nestedAccount: boolean;
}

const HOST_RULES: HostRule[] = [
	{ provider: 'github', hosts: ['github.com'], minSegments: 2, nestedAccount: false },
	{ provider: 'gitlab', hosts: ['gitlab.com'], minSegments: 2, nestedAccount: true },
	{ provider: 'gitee', hosts: ['gitee.com'], minSegments: 2, nestedAccount: false },
	{ provider: 'bitbucket', hosts: ['bitbucket.org'], minSegments: 2, nestedAccount: false }
];

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parse `raw` into a RepoIdentity, or null when the URL is not a
 * repository-shaped URL on one of the four platforms. Sub-paths beyond the
 * repository (tree/blob/commits/...) are ignored - the identity is always
 * the first one (GitHub/Gitee/Bitbucket) or last-two (GitLab) segments.
 */
export function normalizeRepoUrl(raw: string): RepoIdentity | null {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
	const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
	const rule = HOST_RULES.find((candidate) => candidate.hosts.includes(host));
	if (!rule) return null;

	const segments = parsed.pathname
		.split('/')
		.filter((segment) => segment.length > 0)
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
	if (segments.length < rule.minSegments) return null;

	let accountSegments: string[];
	let repoSegment: string;
	if (rule.nestedAccount) {
		// GitLab routes sub-paths behind a bare `-` segment
		// (`/-/tree/main`); anything after it is not part of the identity.
		const dashIndex = segments.indexOf('-');
		const relevant = dashIndex === -1 ? segments : segments.slice(0, dashIndex);
		if (relevant.length < rule.minSegments) return null;
		repoSegment = relevant[relevant.length - 1];
		accountSegments = relevant.slice(0, -1);
	} else {
		accountSegments = [segments[0]];
		repoSegment = segments[1];
	}

	if (repoSegment.toLowerCase().endsWith('.git')) repoSegment = repoSegment.slice(0, -4);
	if (repoSegment.length === 0) return null;
	for (const segment of [...accountSegments, repoSegment]) {
		if (!SEGMENT.test(segment)) return null;
	}
	// A reserved first segment (github.com/settings/...) is a site surface,
	// not an owner - reject it for single-account platforms only.
	if (!rule.nestedAccount && RESERVED_FIRST_SEGMENTS.has(accountSegments[0].toLowerCase()))
		return null;

	const account = accountSegments.join('/');
	return { provider: rule.provider, account, repo: repoSegment };
}

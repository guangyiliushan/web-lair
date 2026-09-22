/**
 * Embed provider registry (spec 3.4) — the closed v1 set: 17 providers with
 * public domains matched here, plus `lair` (no public domain; it matches
 * the site's own relative paths in resolve.ts — see EMBED_PROVIDER_IDS for
 * the full 18-id enumeration).
 *
 * Matching is exact-domain with a single canonicalisation (a leading `www.`
 * is stripped; no other subdomains match) plus a path shape, except where the
 * spec table itself is domain-only (tmdb, qq-music, netease-music). Adding a
 * provider requires amending the spec table and passing the conflict audit,
 * so this list is the single source shared by the decision function, the
 * tests and the favicon proxy allowlist.
 */

export type EmbedProviderId =
	| 'gh-repo'
	| 'gh-commit'
	| 'gh-pr'
	| 'gh-issue'
	| 'gh-discussion'
	| 'gh-file'
	| 'gh-gist'
	| 'tweet'
	| 'youtube'
	| 'bilibili'
	| 'codesandbox'
	| 'arxiv'
	| 'tmdb'
	| 'bangumi'
	| 'qq-music'
	| 'netease-music'
	| 'leetcode'
	| 'lair';

/** The full closed enumeration, including the resolve-side lair id. */
export const EMBED_PROVIDER_IDS: readonly EmbedProviderId[] = [
	'gh-repo',
	'gh-commit',
	'gh-pr',
	'gh-issue',
	'gh-discussion',
	'gh-file',
	'gh-gist',
	'tweet',
	'youtube',
	'bilibili',
	'codesandbox',
	'arxiv',
	'tmdb',
	'bangumi',
	'qq-music',
	'netease-music',
	'leetcode',
	'lair'
];

interface EmbedProvider {
	id: EmbedProviderId;
	/** Canonical domains this provider may match (the proxy allowlist source). */
	domains: readonly string[];
	match(url: URL): boolean;
}

/**
 * Canonical host for registry matching — lowercased with a leading `www.`
 * removed. Exported (as canonicalHost below) so the favicon proxy applies
 * the exact same rule.
 */
function host(url: URL): string {
	return canonicalHost(url.hostname);
}

function segments(url: URL): string[] {
	return url.pathname.split('/').filter(Boolean);
}

function numeric(value: string | undefined): boolean {
	return value !== undefined && /^\d+$/.test(value);
}

const isGithub = (url: URL) => host(url) === 'github.com';

/** github.com top-level paths that are not repositories (gh-repo guard). */
export const GITHUB_RESERVED = new Set([
	'orgs',
	'users',
	'settings',
	'topics',
	'collections',
	'sponsors',
	'marketplace',
	'apps',
	'features',
	'pricing',
	'about',
	'login',
	'signup',
	'explore',
	'trending',
	'new',
	'search',
	'notifications',
	'codespaces'
]);

export const EMBED_PROVIDERS: readonly EmbedProvider[] = [
	// GitHub family — specific shapes before the two-segment repo fallback.
	{
		id: 'gh-commit',
		domains: ['github.com'],
		match: (url) => isGithub(url) && segments(url)[2] === 'commit' && !!segments(url)[3]
	},
	{
		id: 'gh-pr',
		domains: ['github.com'],
		match: (url) => isGithub(url) && segments(url)[2] === 'pull' && numeric(segments(url)[3])
	},
	{
		id: 'gh-issue',
		domains: ['github.com'],
		match: (url) => isGithub(url) && segments(url)[2] === 'issues' && numeric(segments(url)[3])
	},
	{
		id: 'gh-discussion',
		domains: ['github.com'],
		match: (url) => isGithub(url) && segments(url)[2] === 'discussions' && numeric(segments(url)[3])
	},
	{
		id: 'gh-file',
		domains: ['github.com'],
		match: (url) => isGithub(url) && segments(url)[2] === 'blob' && segments(url).length >= 5
	},
	{
		id: 'gh-repo',
		domains: ['github.com'],
		match: (url) =>
			isGithub(url) &&
			segments(url).length === 2 &&
			!GITHUB_RESERVED.has(segments(url)[0].toLowerCase())
	},
	{
		id: 'gh-gist',
		domains: ['gist.github.com'],
		match: (url) => host(url) === 'gist.github.com' && segments(url).length >= 2
	},
	{
		id: 'tweet',
		domains: ['x.com', 'twitter.com'],
		// spec 3.4: `/.../status/{id}` - `status` may sit after any prefix
		// (the /i/web/status/<id> share form is the common one)
		match: (url) => {
			if (host(url) !== 'x.com' && host(url) !== 'twitter.com') return false;
			const segmentsOf = segments(url);
			const at = segmentsOf.indexOf('status');
			return at >= 0 && numeric(segmentsOf[at + 1]);
		}
	},
	{
		id: 'youtube',
		domains: ['youtube.com', 'youtu.be'],
		match: (url) =>
			host(url) === 'youtube.com'
				? url.pathname === '/watch' && url.searchParams.has('v')
				: host(url) === 'youtu.be' && segments(url).length === 1
	},
	{
		id: 'bilibili',
		domains: ['bilibili.com'],
		match: (url) =>
			host(url) === 'bilibili.com' &&
			segments(url)[0] === 'video' &&
			/^BV[0-9A-Za-z]+$/.test(segments(url)[1] ?? '')
	},
	{
		id: 'codesandbox',
		domains: ['codesandbox.io'],
		match: (url) => host(url) === 'codesandbox.io' && segments(url)[0] === 's' && !!segments(url)[1]
	},
	{
		id: 'arxiv',
		domains: ['arxiv.org'],
		match: (url) => host(url) === 'arxiv.org' && segments(url)[0] === 'abs' && !!segments(url)[1]
	},
	{
		// the spec table is domain-only for tmdb
		id: 'tmdb',
		domains: ['themoviedb.org'],
		match: (url) => host(url) === 'themoviedb.org' && segments(url).length >= 2
	},
	{
		id: 'bangumi',
		domains: ['bgm.tv'],
		match: (url) =>
			host(url) === 'bgm.tv' && segments(url)[0] === 'subject' && numeric(segments(url)[1])
	},
	{
		// the spec table is domain-only for the music providers
		id: 'qq-music',
		domains: ['y.qq.com'],
		match: (url) => host(url) === 'y.qq.com'
	},
	{
		id: 'netease-music',
		domains: ['music.163.com'],
		match: (url) => host(url) === 'music.163.com'
	},
	{
		id: 'leetcode',
		domains: ['leetcode.cn'],
		match: (url) =>
			host(url) === 'leetcode.cn' && segments(url)[0] === 'problems' && !!segments(url)[1]
	}
];

/**
 * The favicon proxy's allowlist, DERIVED from each provider's `domains`
 * declaration (spec 6: server-side fetching only ever touches registry
 * domains). A unit test locks the derivation against the positive cases, so
 * adding a provider without declaring its domains fails the suite.
 */
export const EMBED_PROVIDER_DOMAINS: ReadonlySet<string> = new Set(
	EMBED_PROVIDERS.flatMap((provider) => provider.domains)
);

/** Shared canonicalisation: lowercase host with a leading `www.` removed. */
/** Maps a URL to its provider id via the registry matchers — the same
 * source of truth the render side (decideImage consumers) uses. */
export function resolveProviderId(url: string): EmbedProviderId | 'generic' {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'generic';
	}
	// matchers take a parsed URL (same contract as resolve.ts matchWebProvider)
	for (const provider of EMBED_PROVIDERS) {
		if (provider.match(parsed)) return provider.id;
	}
	return 'generic';
}

export function canonicalHost(hostname: string): string {
	return hostname.toLowerCase().replace(/^www\./, '');
}

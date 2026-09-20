/**
 * Embed provider registry (spec 3.4) — the closed v1 set: 17 providers with
 * public domains matched here, plus `mx-space` (no public domain; it matches
 * the site's own relative paths in resolve.ts — see EMBED_PROVIDER_IDS for
 * the full 18-id enumeration).
 *
 * Matching is exact-domain with a single canonicalisation (a leading `www.`
 * is stripped; no other subdomains match) plus a path shape, except where the
 * spec table itself is domain-only (tmdb, qq-music, netease-music). Adding a
 * provider requires amending the spec table and passing the conflict audit,
 * so this list is the single source shared by the decision function, the
 * tests and (later) the favicon proxy allowlist.
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
	| 'mx-space';

/** The full closed enumeration, including the resolve-side mx-space id. */
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
	'mx-space'
];

interface EmbedProvider {
	id: EmbedProviderId;
	match(url: URL): boolean;
}

/** Canonical host: lowercase, leading `www.` removed. */
function host(url: URL): string {
	return url.hostname.toLowerCase().replace(/^www\./, '');
}

function segments(url: URL): string[] {
	return url.pathname.split('/').filter(Boolean);
}

function numeric(value: string | undefined): boolean {
	return value !== undefined && /^\d+$/.test(value);
}

const isGithub = (url: URL) => host(url) === 'github.com';

/** github.com top-level paths that are not repositories (gh-repo guard). */
const GITHUB_RESERVED = new Set([
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
		match: (url) => isGithub(url) && segments(url)[2] === 'commit' && !!segments(url)[3]
	},
	{
		id: 'gh-pr',
		match: (url) => isGithub(url) && segments(url)[2] === 'pull' && numeric(segments(url)[3])
	},
	{
		id: 'gh-issue',
		match: (url) => isGithub(url) && segments(url)[2] === 'issues' && numeric(segments(url)[3])
	},
	{
		id: 'gh-discussion',
		match: (url) => isGithub(url) && segments(url)[2] === 'discussions' && numeric(segments(url)[3])
	},
	{
		id: 'gh-file',
		match: (url) => isGithub(url) && segments(url)[2] === 'blob' && segments(url).length >= 5
	},
	{
		id: 'gh-repo',
		match: (url) =>
			isGithub(url) &&
			segments(url).length === 2 &&
			!GITHUB_RESERVED.has(segments(url)[0].toLowerCase())
	},
	{
		id: 'gh-gist',
		match: (url) => host(url) === 'gist.github.com' && segments(url).length >= 2
	},
	{
		id: 'tweet',
		match: (url) =>
			(host(url) === 'x.com' || host(url) === 'twitter.com') &&
			segments(url)[1] === 'status' &&
			numeric(segments(url)[2])
	},
	{
		id: 'youtube',
		match: (url) =>
			host(url) === 'youtube.com'
				? url.pathname === '/watch' && url.searchParams.has('v')
				: host(url) === 'youtu.be' && segments(url).length === 1
	},
	{
		id: 'bilibili',
		match: (url) =>
			host(url) === 'bilibili.com' &&
			segments(url)[0] === 'video' &&
			/^BV[0-9A-Za-z]+$/.test(segments(url)[1] ?? '')
	},
	{
		id: 'codesandbox',
		match: (url) => host(url) === 'codesandbox.io' && segments(url)[0] === 's' && !!segments(url)[1]
	},
	{
		id: 'arxiv',
		match: (url) => host(url) === 'arxiv.org' && segments(url)[0] === 'abs' && !!segments(url)[1]
	},
	{
		// the spec table is domain-only for tmdb
		id: 'tmdb',
		match: (url) => host(url) === 'themoviedb.org' && segments(url).length >= 2
	},
	{
		id: 'bangumi',
		match: (url) =>
			host(url) === 'bgm.tv' && segments(url)[0] === 'subject' && numeric(segments(url)[1])
	},
	{
		// the spec table is domain-only for the music providers
		id: 'qq-music',
		match: (url) => host(url) === 'y.qq.com'
	},
	{
		id: 'netease-music',
		match: (url) => host(url) === 'music.163.com'
	},
	{
		id: 'leetcode',
		match: (url) =>
			host(url) === 'leetcode.cn' && segments(url)[0] === 'problems' && !!segments(url)[1]
	}
];

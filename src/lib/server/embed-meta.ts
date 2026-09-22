import { error } from '@sveltejs/kit';
import { canonicalHost, GITHUB_RESERVED } from '$lib/components/markdown/embed/registry';

/**
 * GitHub embed metadata proxy (batch 2a) — the metadata side of the rich
 * link cards. Like the favicon proxy this is a server-side fetch, but the
 * upstream is a fixed host (api.github.com, validated by TLS), so only the
 * *user-supplied* URL needs validating, not the connect target:
 *
 * - input gate: https only, canonical host must be github.com, path must
 *   match one of the four enriched card shapes (repo / commit / pull /
 *   issues — aligned with the registry matchers; everything else 404s
 *   before any request is made)
 * - rate limits: unauthenticated GitHub allows 60 req/h per IP; responses
 *   are cached in memory for an hour (per server process) and carry
 *   `cache-control: max-age=3600` so browsers share one fetch per URL.
 *   A GITHUB_TOKEN (optional) lifts the ceiling to 5000/h.
 * - failure contract: every upstream failure (404, rate limit, timeout,
 *   network) answers 204 No Content — the client keeps the static card
 *   and never surfaces an error.
 * - payload: only the whitelist fields below ever leave this module.
 */
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

/** Card shapes this proxy enriches; every other provider stays zero-request. */
export type GithubTarget =
	| { kind: 'repo'; owner: string; repo: string; apiUrl: string }
	| { kind: 'commit'; owner: string; repo: string; sha: string; apiUrl: string }
	| { kind: 'pr'; owner: string; repo: string; number: number; apiUrl: string }
	| { kind: 'issue'; owner: string; repo: string; number: number; apiUrl: string };

const REPO_PATH = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/?$/;
const COMMIT_PATH = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/commit\/([0-9a-f]{7,40})\/?$/;
const PR_PATH = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)\/?$/;
const ISSUE_PATH = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)\/?$/;

/**
 * Maps a github.com page URL to the api.github.com endpoint that describes
 * it. Pure function (unit-locked): no fetch, no throw — a non-matching path
 * returns null.
 */
export function parseGithubTarget(raw: string): GithubTarget | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') return null;
	if (canonicalHost(parsed.hostname) !== 'github.com') return null;
	const path = parsed.pathname;

	let m = COMMIT_PATH.exec(path);
	if (m) {
		const [owner, repo, sha] = [m[1], m[2], m[3]];
		return {
			kind: 'commit',
			owner,
			repo,
			sha,
			apiUrl: `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`
		};
	}
	m = PR_PATH.exec(path);
	if (m) {
		const [owner, repo, number] = [m[1], m[2], Number(m[3])];
		return {
			kind: 'pr',
			owner,
			repo,
			number,
			apiUrl: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
		};
	}
	m = ISSUE_PATH.exec(path);
	if (m) {
		const [owner, repo, number] = [m[1], m[2], Number(m[3])];
		return {
			kind: 'issue',
			owner,
			repo,
			number,
			apiUrl: `https://api.github.com/repos/${owner}/${repo}/issues/${number}`
		};
	}
	m = REPO_PATH.exec(path);
	if (m && !GITHUB_RESERVED.has(m[1].toLowerCase())) {
		const [owner, repo] = [m[1], m[2]];
		return { kind: 'repo', owner, repo, apiUrl: `https://api.github.com/repos/${owner}/${repo}` };
	}
	return null;
}

export interface EmbedMetaResponse {
	kind: 'repo' | 'commit' | 'pr' | 'issue';
	title?: string;
	description?: string;
	stars?: number;
	language?: string;
	additions?: number;
	deletions?: number;
	sha?: string;
	state?: string;
	avatarUrl?: string | null;
	repoName?: string;
}

/** Whitelist projection: unknown upstream fields never reach the client. */
function projectPayload(target: GithubTarget, json: unknown): EmbedMetaResponse {
	const raw = (json ?? {}) as Record<string, unknown>;
	const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
	const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
	if (target.kind === 'repo') {
		const owner = raw.owner as Record<string, unknown> | undefined;
		return {
			kind: 'repo',
			title: str(raw.full_name),
			description: str(raw.description),
			stars: num(raw.stargazers_count),
			language: str(raw.language),
			avatarUrl: str((owner as Record<string, unknown> | undefined)?.avatar_url) ?? null
		};
	}
	if (target.kind === 'commit') {
		const commit = raw.commit as Record<string, unknown> | undefined;
		const stats = raw.stats as Record<string, unknown> | undefined;
		const author = raw.author as Record<string, unknown> | undefined;
		const message = str(commit?.message);
		return {
			kind: 'commit',
			title: message ? message.split('\n')[0] : undefined,
			additions: num(stats?.additions),
			deletions: num(stats?.deletions),
			sha: target.sha.slice(0, 7),
			avatarUrl: str(author?.avatar_url) ?? null,
			repoName: `${target.owner}/${target.repo}`
		};
	}
	if (target.kind === 'pr') {
		const user = raw.user as Record<string, unknown> | undefined;
		return {
			kind: 'pr',
			title: str(raw.title),
			additions: num(raw.additions),
			deletions: num(raw.deletions),
			avatarUrl: str(user?.avatar_url) ?? null,
			repoName: `${target.owner}/${target.repo}`
		};
	}
	const user = raw.user as Record<string, unknown> | undefined;
	return {
		kind: 'issue',
		title: str(raw.title),
		state: str(raw.state),
		avatarUrl: str(user?.avatar_url) ?? null,
		repoName: `${target.owner}/${target.repo}`
	};
}

interface CacheEntry {
	payload: EmbedMetaResponse;
	expiresAt: number;
}
const metaCache = new Map<string, CacheEntry>();

/** Test hook: the in-memory cache is process-global by design. */
export function clearEmbedMetaCache(): void {
	metaCache.clear();
}

export async function handleEmbedMetaRequest(
	requestUrl: URL,
	options: { token?: string } = {}
): Promise<Response> {
	const target = parseGithubTarget(requestUrl.searchParams.get('url') ?? '');
	if (requestUrl.searchParams.get('url') === null) throw error(400, 'missing url');
	if (!target) throw error(403, 'not an enrichable github.com card url');

	const cached = metaCache.get(target.apiUrl);
	if (cached && cached.expiresAt > Date.now()) {
		return new Response(JSON.stringify(cached.payload), { headers: metaHeaders() });
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28'
	};
	if (options.token) headers.authorization = `Bearer ${options.token}`;
	try {
		const response = await fetch(target.apiUrl, {
			signal: controller.signal,
			headers,
			redirect: 'error'
		});
		// Upstream failures (404, 403 rate limit, …) degrade to 204 — the
		// client keeps the static card and never sees an error surface.
		if (!response.ok) return new Response(null, { status: 204 });
		const json: unknown = await response.json().catch(() => null);
		if (!json || typeof json !== 'object') return new Response(null, { status: 204 });
		// Never expose private-repo metadata through the public proxy: a
		// server-held token must not turn the endpoint into an oracle.
		if ((json as Record<string, unknown>).private === true) {
			return new Response(null, { status: 204 });
		}
		const payload = projectPayload(target, json);
		metaCache.set(target.apiUrl, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
		// insertion-order eviction keeps the process cache bounded
		if (metaCache.size > CACHE_MAX) {
			const oldest = metaCache.keys().next().value;
			if (oldest !== undefined) metaCache.delete(oldest);
		}
		return new Response(JSON.stringify(payload), { headers: metaHeaders() });
	} catch {
		return new Response(null, { status: 204 });
	} finally {
		clearTimeout(timer);
	}
}

function metaHeaders(): Record<string, string> {
	return {
		'content-type': 'application/json',
		'cache-control': 'public, max-age=3600',
		'x-content-type-options': 'nosniff'
	};
}

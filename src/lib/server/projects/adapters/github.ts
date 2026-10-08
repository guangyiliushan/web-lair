import { fetchJson, isRateLimitExhausted, ProjectsFetchError, type FetchJson } from '../fetch.ts';
import type { RawRepoMeta, RepoIdentity } from '../types.ts';
import { asArray, asRecord, dateOrNull, num, requiredId, str } from './shared.ts';

/**
 * GitHub adapter (plan §3.2/§3.3): anonymous 60 req/h, `PROJECTS_GITHUB_TOKEN`
 * lifts to 5,000. Serial paging via the `Link: rel="next"` header; private
 * repositories are dropped at mapping time, forks are kept (the sync layer
 * applies the fork filter uniformly across platforms).
 */
export const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
/** Defensive cap: personal accounts have tens of repos (≤ 1 page). */
const MAX_PAGES = 10;

export interface UserReposResult {
	repos: RawRepoMeta[];
	/** True when pagination stopped early because the quota ran out. */
	rateLimited: boolean;
	/** True when the page cap stopped paging while more pages existed. */
	truncated: boolean;
}

function githubHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28'
	};
	const token = process.env.PROJECTS_GITHUB_TOKEN;
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

export function mapGithubRepo(value: unknown): RawRepoMeta | null {
	const raw = asRecord(value, 'github repo');
	if (raw.private === true) return null;
	const owner =
		raw.owner !== null && typeof raw.owner === 'object'
			? (raw.owner as Record<string, unknown>)
			: {};
	return {
		externalId: requiredId(raw.id, 'github repo'),
		fullName: str(raw.full_name) ?? '',
		projectUrl: str(raw.html_url) ?? '',
		homepage: str(raw.homepage),
		avatar: str(owner.avatar_url),
		description: str(raw.description),
		language: str(raw.language),
		stars: num(raw.stargazers_count),
		pushedAt: dateOrNull(raw.pushed_at),
		archived: raw.archived === true,
		fork: raw.fork === true
	};
}

function nextLink(header: string | null): string | null {
	if (!header) return null;
	for (const part of header.split(',')) {
		const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
		if (match) return match[1];
	}
	return null;
}

export async function fetchUserRepos(
	account: string,
	deps: { fetchJson?: FetchJson } = {}
): Promise<UserReposResult> {
	const doFetch = deps.fetchJson ?? fetchJson;
	const repos: RawRepoMeta[] = [];
	let url: string | null =
		`${GITHUB_API}/users/${encodeURIComponent(account)}/repos?per_page=${PER_PAGE}&type=owner`;
	let pages = 0;
	while (url && pages < MAX_PAGES) {
		pages += 1;
		const response = await doFetch(url, { headers: githubHeaders() });
		for (const item of asArray(response.json, 'github repo list')) {
			const mapped = mapGithubRepo(item);
			if (mapped) repos.push(mapped);
		}
		url = nextLink(response.headers.get('link'));
		if (url && isRateLimitExhausted('github', response.headers).exhausted) {
			return { repos, rateLimited: true, truncated: false };
		}
	}
	return { repos, rateLimited: false, truncated: url !== null };
}

export async function fetchRepo(
	identity: RepoIdentity,
	deps: { fetchJson?: FetchJson } = {}
): Promise<RawRepoMeta> {
	const doFetch = deps.fetchJson ?? fetchJson;
	const url = `${GITHUB_API}/repos/${encodeURIComponent(identity.account)}/${encodeURIComponent(identity.repo)}`;
	const response = await doFetch(url, { headers: githubHeaders() });
	const mapped = mapGithubRepo(response.json);
	if (!mapped) throw new ProjectsFetchError('not_found', 'repository is private');
	return mapped;
}

import { fetchJson, isRateLimitExhausted, ProjectsFetchError, type FetchJson } from '../fetch.ts';
import type { RawRepoMeta, RepoIdentity } from '../types.ts';
import { asArray, asRecord, dateOrNull, num, requiredId, str } from './shared.ts';
import type { UserReposResult } from './github.ts';

/**
 * Gitee adapter (plan §3.2): anonymous 60 req/min; `PROJECTS_GITEE_TOKEN`
 * travels as the `access_token` query parameter (the platform's documented
 * auth style). Pagination is `page`-based (increment until a short page);
 * `private === true` items are dropped at mapping time.
 */
export const GITEE_API = 'https://gitee.com/api/v5';
const PER_PAGE = 100;
const MAX_PAGES = 10;

function tokenSuffix(): string {
	const token = process.env.PROJECTS_GITEE_TOKEN;
	return token ? `&access_token=${encodeURIComponent(token)}` : '';
}

export function mapGiteeRepo(value: unknown): RawRepoMeta | null {
	const raw = asRecord(value, 'gitee repo');
	if (raw.private === true) return null;
	const namespace =
		raw.namespace !== null && typeof raw.namespace === 'object'
			? (raw.namespace as Record<string, unknown>)
			: {};
	const owner =
		raw.owner !== null && typeof raw.owner === 'object'
			? (raw.owner as Record<string, unknown>)
			: {};
	return {
		externalId: requiredId(raw.id, 'gitee repo'),
		fullName: str(raw.full_name) ?? '',
		projectUrl: str(raw.html_url) ?? '',
		homepage: str(raw.homepage),
		avatar: str(namespace.avatar_url) ?? str(owner.avatar_url),
		description: str(raw.description),
		language: str(raw.language),
		stars: num(raw.stargazers_count),
		pushedAt: dateOrNull(raw.pushed_at),
		archived: raw.archived === true,
		fork: raw.fork === true
	};
}

export async function fetchUserRepos(
	account: string,
	deps: { fetchJson?: FetchJson } = {}
): Promise<UserReposResult> {
	const doFetch = deps.fetchJson ?? fetchJson;
	const repos: RawRepoMeta[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const url = `${GITEE_API}/users/${encodeURIComponent(account)}/repos?per_page=${PER_PAGE}&page=${page}${tokenSuffix()}`;
		const response = await doFetch(url);
		const items = asArray(response.json, 'gitee repo list');
		for (const item of items) {
			const mapped = mapGiteeRepo(item);
			if (mapped) repos.push(mapped);
		}
		if (items.length < PER_PAGE) return { repos, rateLimited: false, truncated: false };
		if (isRateLimitExhausted('gitee', response.headers).exhausted) {
			return { repos, rateLimited: true, truncated: false };
		}
	}
	// The loop only runs out while the last page was full - more may exist.
	return { repos, rateLimited: false, truncated: true };
}

export async function fetchRepo(
	identity: RepoIdentity,
	deps: { fetchJson?: FetchJson } = {}
): Promise<RawRepoMeta> {
	const doFetch = deps.fetchJson ?? fetchJson;
	const token = process.env.PROJECTS_GITEE_TOKEN;
	const suffix = token ? `?access_token=${encodeURIComponent(token)}` : '';
	const url = `${GITEE_API}/repos/${encodeURIComponent(identity.account)}/${encodeURIComponent(identity.repo)}${suffix}`;
	const response = await doFetch(url);
	const mapped = mapGiteeRepo(response.json);
	if (!mapped) throw new ProjectsFetchError('not_found', 'repository is private');
	return mapped;
}

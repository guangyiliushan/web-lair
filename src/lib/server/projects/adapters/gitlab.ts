import { fetchJson, isRateLimitExhausted, ProjectsFetchError, type FetchJson } from '../fetch.ts';
import type { RawRepoMeta, RepoIdentity } from '../types.ts';
import { asArray, asRecord, dateOrNull, num, requiredId, str } from './shared.ts';
import type { UserReposResult } from './github.ts';

/**
 * GitLab adapter (plan §3.2): anonymous quota drops to 60 req/h per IP on
 * 2026-10-19 (ledger §18; `PROJECTS_GITLAB_TOKEN` = `PRIVATE-TOKEN` lifts to
 * 5,000/h authenticated). Serial paging via the `x-next-page` header. The
 * list endpoint carries no `language` (left null - "call /languages later"
 * is a registered item); `visibility=public` is requested AND re-checked.
 * Group / subgroup namespaces are NOT valid sync targets yet (org sync is a
 * registered item) - the adapter fails loudly instead of paging a 404.
 */
export const GITLAB_API = 'https://gitlab.com/api/v4';
const PER_PAGE = 100;
const MAX_PAGES = 10;

function gitlabHeaders(): Record<string, string> {
	const token = process.env.PROJECTS_GITLAB_TOKEN;
	return token ? { 'private-token': token } : {};
}

export function mapGitlabProject(value: unknown): RawRepoMeta | null {
	const raw = asRecord(value, 'gitlab project');
	if (raw.visibility !== 'public') return null;
	const namespace =
		raw.namespace !== null && typeof raw.namespace === 'object'
			? (raw.namespace as Record<string, unknown>)
			: {};
	return {
		externalId: requiredId(raw.id, 'gitlab project'),
		fullName: str(raw.path_with_namespace) ?? '',
		projectUrl: str(raw.web_url) ?? '',
		homepage: null,
		avatar: str(namespace.avatar_url),
		description: str(raw.description),
		language: null,
		stars: num(raw.star_count),
		pushedAt: dateOrNull(raw.last_activity_at),
		archived: raw.archived === true,
		// `!= null` covers both a missing field and an explicit null.
		fork: raw.forked_from_project != null
	};
}

export async function fetchUserRepos(
	account: string,
	deps: { fetchJson?: FetchJson } = {}
): Promise<UserReposResult> {
	if (account.includes('/')) {
		throw new ProjectsFetchError(
			'parse',
			`gitlab group namespaces are not supported as sync targets yet: ${account}`
		);
	}
	const doFetch = deps.fetchJson ?? fetchJson;
	const repos: RawRepoMeta[] = [];
	const base = `${GITLAB_API}/users/${encodeURIComponent(account)}/projects?per_page=${PER_PAGE}&visibility=public`;
	let page: string | null = null;
	let pages = 0;
	do {
		pages += 1;
		const url = page === null ? base : `${base}&page=${encodeURIComponent(page)}`;
		const response = await doFetch(url, { headers: gitlabHeaders() });
		for (const item of asArray(response.json, 'gitlab project list')) {
			const mapped = mapGitlabProject(item);
			if (mapped) repos.push(mapped);
		}
		page = response.headers.get('x-next-page') || null;
		if (page && isRateLimitExhausted('gitlab', response.headers).exhausted) {
			return { repos, rateLimited: true, truncated: false };
		}
	} while (page && pages < MAX_PAGES);
	return { repos, rateLimited: false, truncated: page !== null };
}

export async function fetchRepo(
	identity: RepoIdentity,
	deps: { fetchJson?: FetchJson } = {}
): Promise<RawRepoMeta> {
	const doFetch = deps.fetchJson ?? fetchJson;
	const path = encodeURIComponent(`${identity.account}/${identity.repo}`);
	const response = await doFetch(`${GITLAB_API}/projects/${path}`, { headers: gitlabHeaders() });
	const mapped = mapGitlabProject(response.json);
	if (!mapped) throw new ProjectsFetchError('not_found', 'project is not public');
	return mapped;
}

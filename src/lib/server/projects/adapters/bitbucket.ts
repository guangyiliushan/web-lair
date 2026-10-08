import { fetchJson, isRateLimitExhausted, ProjectsFetchError, type FetchJson } from '../fetch.ts';
import type { RawRepoMeta, RepoIdentity } from '../types.ts';
import { asArray, asRecord, dateOrNull, str } from './shared.ts';
import type { UserReposResult } from './github.ts';

/**
 * Bitbucket adapter (plan §3.2): anonymous 60 req/h per workspace; Basic
 * auth (email + API token) via `PROJECTS_BITBUCKET_USER` +
 * `PROJECTS_BITBUCKET_TOKEN`. Cursor pagination through the response's
 * `next` link. Known upstream gaps kept as nulls: no stars, no archived
 * flag, no per-page rate-limit headers (429 is the only exhaustion signal).
 */
export const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
const PAGE_LEN = 100;
const MAX_PAGES = 10;

function bitbucketHeaders(): Record<string, string> {
	const user = process.env.PROJECTS_BITBUCKET_USER;
	const token = process.env.PROJECTS_BITBUCKET_TOKEN;
	if (!user || !token) return {};
	const basic = Buffer.from(`${user}:${token}`).toString('base64');
	return { authorization: `Basic ${basic}` };
}

export function mapBitbucketRepo(value: unknown, workspace: string): RawRepoMeta | null {
	const raw = asRecord(value, 'bitbucket repo');
	if (raw.is_private === true) return null;
	// full_name is the only display identity Bitbucket gives us; a payload
	// without it is a shape change, not a row to import with a fake name.
	const fullName = str(raw.full_name);
	if (!fullName) {
		throw new ProjectsFetchError(
			'parse',
			`bitbucket repository without full_name (workspace ${workspace})`
		);
	}
	const links =
		raw.links !== null && typeof raw.links === 'object'
			? (raw.links as Record<string, unknown>)
			: {};
	const html =
		links.html !== null && typeof links.html === 'object'
			? (links.html as Record<string, unknown>)
			: {};
	const avatarLink =
		links.avatar !== null && typeof links.avatar === 'object'
			? (links.avatar as Record<string, unknown>)
			: {};
	const uuid = str(raw.uuid) ?? '';
	return {
		// Bitbucket uuids arrive brace-wrapped ({...}); strip before storing.
		externalId: uuid.replace(/^\{/, '').replace(/\}$/, ''),
		fullName,
		projectUrl: str(html.href) ?? '',
		homepage: str(raw.website),
		avatar: str(avatarLink.href),
		description: str(raw.description),
		language: str(raw.language),
		stars: null,
		pushedAt: dateOrNull(raw.updated_on),
		archived: false,
		// `parent` present == this repo is a fork; absent/null == not a fork.
		fork: raw.parent != null
	};
}

export async function fetchUserRepos(
	workspace: string,
	deps: { fetchJson?: FetchJson } = {}
): Promise<UserReposResult> {
	const doFetch = deps.fetchJson ?? fetchJson;
	const repos: RawRepoMeta[] = [];
	let url: string | null =
		`${BITBUCKET_API}/repositories/${encodeURIComponent(workspace)}?pagelen=${PAGE_LEN}`;
	let pages = 0;
	while (url && pages < MAX_PAGES) {
		pages += 1;
		const response = await doFetch(url, { headers: bitbucketHeaders() });
		const body = asRecord(response.json, 'bitbucket repo page');
		for (const item of asArray(body.values, 'bitbucket repo list')) {
			const mapped = mapBitbucketRepo(item, workspace);
			if (mapped) repos.push(mapped);
		}
		url = str(body.next);
		if (url && isRateLimitExhausted('bitbucket', response.headers)) {
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
	const url = `${BITBUCKET_API}/repositories/${encodeURIComponent(identity.account)}/${encodeURIComponent(identity.repo)}`;
	const response = await doFetch(url, { headers: bitbucketHeaders() });
	const mapped = mapBitbucketRepo(response.json, identity.account);
	if (!mapped) throw new ProjectsFetchError('not_found', 'repository is private');
	if (mapped.externalId.length === 0) {
		throw new ProjectsFetchError('parse', 'bitbucket repository has no uuid');
	}
	return mapped;
}

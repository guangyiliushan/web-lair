import { describe, expect, it } from 'vitest';
import * as bitbucket from './bitbucket';
import * as gitee from './gitee';
import * as github from './github';
import * as gitlab from './gitlab';
import type { FetchJson, FetchJsonResponse } from '../fetch';

/**
 * T8 (plan §7): offline fixtures for the four adapters - list mapping,
 * private / fork handling, pagination shapes (GitHub Link header, GitLab
 * x-next-page, Bitbucket cursor, Gitee page count) and the single-repo GET.
 */

const response = (json: unknown, headers: Record<string, string> = {}): FetchJsonResponse => ({
	status: 200,
	headers: new Headers(headers),
	json
});

describe('github adapter', () => {
	it('maps list items, drops private rows, keeps forks for the sync filter', async () => {
		const fetchJson: FetchJson = async (url) => {
			expect(url).toContain('https://api.github.com/users/guang/repos');
			expect(url).toContain('type=owner');
			return response([
				{
					id: 1,
					full_name: 'guang/reborn',
					html_url: 'https://github.com/guang/reborn',
					homepage: 'https://r.example',
					owner: { avatar_url: 'https://a.example/u.png' },
					language: 'TypeScript',
					stargazers_count: 12,
					pushed_at: '2026-10-01T00:00:00Z',
					archived: true,
					fork: false,
					description: 'd',
					private: false
				},
				{ id: 2, full_name: 'guang/private', private: true },
				{
					id: 3,
					full_name: 'guang/forked',
					html_url: 'https://github.com/guang/forked',
					fork: true,
					private: false,
					owner: {}
				}
			]);
		};
		const { repos, rateLimited } = await github.fetchUserRepos('guang', { fetchJson });
		expect(rateLimited).toBe(false);
		expect(repos).toHaveLength(2);
		expect(repos[0]).toMatchObject({
			externalId: '1',
			fullName: 'guang/reborn',
			language: 'TypeScript',
			stars: 12,
			archived: true,
			fork: false
		});
		expect(repos[1]).toMatchObject({ externalId: '3', fork: true });
	});

	it('follows the Link rel="next" header across pages', async () => {
		const urls: string[] = [];
		const fetchJson: FetchJson = async (url) => {
			urls.push(url);
			if (urls.length === 1) {
				return response(
					[
						{
							id: 1,
							full_name: 'a/one',
							html_url: 'https://github.com/a/one',
							private: false,
							owner: {}
						}
					],
					{
						link: '<https://api.github.com/users/a/repos?per_page=100&page=2>; rel="next", <https://api.github.com/users/a/repos?page=9>; rel="last"'
					}
				);
			}
			return response([
				{
					id: 2,
					full_name: 'a/two',
					html_url: 'https://github.com/a/two',
					private: false,
					owner: {}
				}
			]);
		};
		const { repos } = await github.fetchUserRepos('a', { fetchJson });
		expect(repos.map((repo) => repo.externalId)).toEqual(['1', '2']);
		// The second request must be the page-2 URL (review 2026-10-08).
		expect(urls[1]).toContain('page=2');
	});

	it('fetches a single repository for refresh', async () => {
		const fetchJson: FetchJson = async (url) => {
			expect(url).toBe('https://api.github.com/repos/guang/reborn');
			return response({
				id: 1,
				full_name: 'guang/reborn',
				html_url: 'https://github.com/guang/reborn',
				private: false,
				owner: {}
			});
		};
		const repo = await github.fetchRepo(
			{ provider: 'github', account: 'guang', repo: 'reborn' },
			{ fetchJson }
		);
		expect(repo.externalId).toBe('1');
	});

	it('surfaces a missing id as a parse failure (platform shape change signal)', async () => {
		const fetchJson: FetchJson = async () => response({ full_name: 'x', private: false });
		await expect(
			github.fetchRepo({ provider: 'github', account: 'guang', repo: 'reborn' }, { fetchJson })
		).rejects.toMatchObject({ kind: 'parse' });
	});
});

describe('gitlab adapter', () => {
	it('maps public projects, drops non-public, follows x-next-page', async () => {
		const urls: string[] = [];
		const fetchJson: FetchJson = async (url) => {
			urls.push(url);
			if (urls.length === 1) {
				return response(
					[
						{
							id: 9,
							path_with_namespace: 'group/sub/project',
							web_url: 'https://gitlab.com/group/sub/project',
							namespace: { avatar_url: 'https://a.example/g.png' },
							star_count: 5,
							last_activity_at: '2026-10-02T00:00:00Z',
							forked_from_project: { id: 1 },
							description: 'd',
							archived: false,
							visibility: 'public'
						},
						{ id: 10, visibility: 'private' }
					],
					{ 'x-next-page': '2' }
				);
			}
			return response([
				{
					id: 11,
					path_with_namespace: 'group/other',
					web_url: 'https://gitlab.com/group/other',
					visibility: 'public',
					forked_from_project: null
				}
			]);
		};
		const { repos } = await gitlab.fetchUserRepos('group', { fetchJson });
		// group namespaces are rejected as sync targets.
		await expect(gitlab.fetchUserRepos('group/sub', { fetchJson })).rejects.toMatchObject({
			kind: 'parse'
		});
		expect(urls[0]).toContain('visibility=public');
		expect(urls[1]).toContain('page=2');
		expect(repos.map((repo) => repo.externalId)).toEqual(['9', '11']);
		expect(repos[0]).toMatchObject({
			language: null,
			stars: 5,
			fork: true,
			pushedAt: new Date('2026-10-02T00:00:00Z')
		});
		expect(repos[1]).toMatchObject({ fork: false });
	});
});

describe('gitee adapter', () => {
	it('maps a short page and stops paging', async () => {
		let calls = 0;
		const fetchJson: FetchJson = async () => {
			calls += 1;
			return response([
				{
					id: 21,
					full_name: 'u/r',
					html_url: 'https://gitee.com/u/r',
					homepage: '',
					namespace: { avatar_url: null },
					language: 'Go',
					stargazers_count: 3,
					pushed_at: '2026-10-03T00:00:00Z',
					fork: false,
					description: 'x',
					private: false
				}
			]);
		};
		const { repos } = await gitee.fetchUserRepos('u', { fetchJson });
		expect(calls).toBe(1);
		expect(repos[0]).toMatchObject({ externalId: '21', homepage: null, language: 'Go', stars: 3 });
	});
});

describe('bitbucket adapter', () => {
	it('strips uuid braces, follows the cursor and maps the avatar/website links', async () => {
		const urls: string[] = [];
		const fetchJson: FetchJson = async (url) => {
			urls.push(url);
			if (urls.length === 1) {
				return response({
					values: [
						{
							uuid: '{aaa-bbb}',
							full_name: 'ws/repo',
							links: {
								html: { href: 'https://bitbucket.org/ws/repo' },
								avatar: { href: 'https://bb.example/a.png' }
							},
							website: 'https://repo.example',
							language: 'Python',
							updated_on: '2026-10-04T00:00:00Z',
							parent: null,
							is_private: false,
							description: null
						},
						{ uuid: '{priv}', is_private: true }
					],
					next: 'https://api.bitbucket.org/2.0/repositories/ws?page=2'
				});
			}
			return response({ values: [], next: null });
		};
		const { repos } = await bitbucket.fetchUserRepos('ws', { fetchJson });
		expect(urls).toHaveLength(2);
		expect(repos).toHaveLength(1);
		expect(repos[0]).toMatchObject({
			externalId: 'aaa-bbb',
			fullName: 'ws/repo',
			projectUrl: 'https://bitbucket.org/ws/repo',
			homepage: 'https://repo.example',
			avatar: 'https://bb.example/a.png',
			language: 'Python',
			stars: null,
			archived: false,
			fork: false
		});
	});

	it('keeps its serial politeness (no auth header without env configuration)', async () => {
		const seen: Record<string, string>[] = [];
		const fetchJson: FetchJson = async (_url, init) => {
			seen.push((init?.headers ?? {}) as Record<string, string>);
			return response({ values: [], next: null });
		};
		await bitbucket.fetchUserRepos('ws', { fetchJson });
		expect(seen).toHaveLength(1);
		expect(seen[0].authorization).toBeUndefined();
	});
});

describe('adapter hardening (review 2026-10-08)', () => {
	it('flags truncated lists at the page cap and stops at 10 pages', async () => {
		let pages = 0;
		const fetchJson: FetchJson = async () => {
			pages += 1;
			return response(
				[
					{
						id: 1000 + pages,
						full_name: `a/r${pages}`,
						html_url: `https://github.com/a/r${pages}`,
						private: false,
						owner: {}
					}
				],
				{ link: '<https://api.github.com/users/a/repos?page=99>; rel="next"' }
			);
		};
		const result = await github.fetchUserRepos('a', { fetchJson });
		expect(pages).toBe(10);
		expect(result.truncated).toBe(true);
		expect(result.rateLimited).toBe(false);
	});

	it('rejects a bitbucket repo payload without full_name as a shape change', async () => {
		const fetchJson: FetchJson = async () =>
			response({ values: [{ uuid: '{x}', is_private: false }], next: null });
		await expect(bitbucket.fetchUserRepos('ws', { fetchJson })).rejects.toMatchObject({
			kind: 'parse'
		});
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	clearEmbedMetaCache,
	handleEmbedMetaRequest,
	parseGithubTarget
} from '$lib/server/embed-meta';

function requestFor(url: string): URL {
	return new URL(`http://localhost/api/embed-meta?url=${encodeURIComponent(url)}`);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('parseGithubTarget', () => {
	it('maps the four enriched shapes to api.github.com endpoints', () => {
		expect(parseGithubTarget('https://github.com/example-org/example-repo')).toEqual({
			kind: 'repo',
			owner: 'example-org',
			repo: 'example-repo',
			apiUrl: 'https://api.github.com/repos/example-org/example-repo'
		});
		expect(
			parseGithubTarget(
				'https://github.com/example-org/example-repo/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
			)
		).toMatchObject({
			kind: 'commit',
			sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
		});
		expect(parseGithubTarget('https://github.com/example-org/example-repo/pull/129')).toMatchObject(
			{
				kind: 'pr',
				number: 129
			}
		);
		expect(
			parseGithubTarget('https://github.com/example-org/example-repo/issues/12')
		).toMatchObject({
			kind: 'issue',
			number: 12
		});
	});

	it('rejects other hosts, protocols and unmatched shapes', () => {
		expect(parseGithubTarget('https://evilgithub.com/a/b')).toBeNull();
		expect(parseGithubTarget('https://github.com.evil.example/a/b')).toBeNull();
		expect(parseGithubTarget('http://github.com/a/b')).toBeNull();
		expect(parseGithubTarget('https://github.com/orgs/teams')).toBeNull();
		expect(parseGithubTarget('https://github.com/a/b/releases/tag/v1')).toBeNull();
		expect(parseGithubTarget('not a url')).toBeNull();
	});
});

describe('handleEmbedMetaRequest', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		clearEmbedMetaCache();
	});

	it('projects only whitelisted repo fields and sets cache headers', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				full_name: 'example-org/example-repo',
				description: 'Vue core',
				stargazers_count: 48000,
				language: 'TypeScript',
				html_url: 'https://github.com/example-org/example-repo',
				owner: { avatar_url: 'https://avatars.githubusercontent.com/u/6128107' },
				secret_injected_field: 'must-not-leak'
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const res = await handleEmbedMetaRequest(
			requestFor('https://github.com/example-org/example-repo')
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
		const body = await res.json();
		expect(body).toEqual({
			kind: 'repo',
			title: 'example-org/example-repo',
			description: 'Vue core',
			stars: 48000,
			language: 'TypeScript',
			avatarUrl: 'https://avatars.githubusercontent.com/u/6128107'
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0][0]).toBe(
			'https://api.github.com/repos/example-org/example-repo'
		);
	});

	it('takes the first line of commit messages and the diff stats', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				jsonResponse({
					commit: { message: 'fix: something\n\nbody line' },
					stats: { additions: 9, deletions: 10, total: 19 },
					author: { avatar_url: 'https://avatars.githubusercontent.com/u/1' },
					secret: true
				})
			)
		);
		const res = await handleEmbedMetaRequest(
			requestFor(
				'https://github.com/example-org/example-repo/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'
			)
		);
		const body = await res.json();
		expect(body).toEqual({
			kind: 'commit',
			title: 'fix: something',
			additions: 9,
			deletions: 10,
			sha: 'a1b2c3d',
			avatarUrl: 'https://avatars.githubusercontent.com/u/1',
			repoName: 'example-org/example-repo'
		});
	});

	it('serves the second identical url from cache without refetching', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ full_name: 'a/b' }));
		vi.stubGlobal('fetch', fetchMock);
		await handleEmbedMetaRequest(requestFor('https://github.com/a/b'));
		const second = await handleEmbedMetaRequest(requestFor('https://github.com/a/b'));
		expect(second.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it('degrades every upstream failure to 204 (never an error surface)', async () => {
		for (const status of [404, 403, 429, 500]) {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status })));
			const res = await handleEmbedMetaRequest(requestFor('https://github.com/a/b'));
			expect(res.status, `upstream ${status}`).toBe(204);
		}
	});

	it('attaches the authorization header when a token is provided', async () => {
		const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ full_name: 'a/b' }));
		vi.stubGlobal('fetch', fetchMock);
		await handleEmbedMetaRequest(requestFor('https://github.com/a/b'), { token: 't0k3n' });
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer t0k3n');
	});

	it('rejects non-github and non-enrichable urls before any fetch', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(handleEmbedMetaRequest(requestFor('https://example.com/x'))).rejects.toThrow();
		await expect(
			handleEmbedMetaRequest(requestFor('https://github.com/a/b/blob/main/x.ts'))
		).rejects.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('answers 204 for private repos and never caches the answer', async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(jsonResponse({ private: true, full_name: 'o/private-repo' }));
		vi.stubGlobal('fetch', fetchSpy);
		const url = requestFor('https://github.com/o/private-repo');
		const res = await handleEmbedMetaRequest(url, {});
		expect(res.status).toBe(204);
		// uncached: a second request must hit upstream again, not replay a hit
		await handleEmbedMetaRequest(url, {});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});

import { describe, expect, it } from 'vitest';
import { decideImage, imageExtension } from '$lib/components/markdown/embed/resolve';
import {
	canonicalHost,
	EMBED_PROVIDER_DOMAINS,
	EMBED_PROVIDER_IDS
} from '$lib/components/markdown/embed/registry';

const providerOf = (url: string) => {
	const decision = decideImage({ url });
	return decision.kind === 'embed' ? decision.provider : null;
};

/** Canonical URLs per registry id; exhaustiveness is asserted below. */
const POSITIVES: Record<string, string> = {
	'https://github.com/foo/bar': 'gh-repo',
	'https://github.com/foo/bar/commit/abc123': 'gh-commit',
	'https://github.com/foo/bar/pull/123': 'gh-pr',
	'https://github.com/foo/bar/issues/123': 'gh-issue',
	'https://github.com/foo/bar/discussions/123': 'gh-discussion',
	'https://github.com/foo/bar/blob/main/src/index.ts#L10-L20': 'gh-file',
	'https://gist.github.com/user/9f8e7d': 'gh-gist',
	'https://x.com/user/status/123456': 'tweet',
	'https://twitter.com/user/status/123456': 'tweet',
	'https://x.com/i/web/status/42': 'tweet',
	'https://www.youtube.com/watch?v=aaaaaaaaaaa': 'youtube',
	'https://youtu.be/aaaaaaaaaaa': 'youtube',
	'https://www.bilibili.com/video/BV1xx411c7mD': 'bilibili',
	'https://codesandbox.io/s/abc123': 'codesandbox',
	'https://arxiv.org/abs/2401.00001': 'arxiv',
	'https://www.themoviedb.org/movie/123': 'tmdb',
	'https://bgm.tv/subject/12345': 'bangumi',
	'https://y.qq.com/n/ryqq/songDetail/abc': 'qq-music',
	'https://music.163.com/song?id=123': 'netease-music',
	'https://leetcode.cn/problems/two-sum/': 'leetcode',
	'/posts/hello-world': 'lair',
	'/notes/some-note': 'lair',
	'/thinking/42': 'lair'
};

const NEGATIVES = [
	'https://github.com/foo',
	'https://github.com/foo/bar/tree/main',
	'https://github.com/foo/bar/issues/not-a-number',
	'https://github.com/foo/bar/pull',
	'https://github.com/foo/bar/commit',
	'https://github.com/foo/bar/discussions/x',
	'https://github.com/orgs/foo',
	'https://github.com/settings/profile',
	'https://evilgithub.com/foo/bar',
	'https://github.com.evil.example/foo/bar',
	'https://gist.github.com/user',
	'https://x.com/user/statuses/123',
	'https://notyoutube.com/watch?v=1',
	'https://bilibili.com/video/av123',
	'https://codesandbox.io/embed/abc123',
	'https://arxiv.org/pdf/2401.00001',
	'https://themoviedb.org/',
	'https://bgm.tv/subject/abc',
	'https://y.qq.com.evil.example/x',
	'https://music.163.com.evil.example/song',
	'https://leetcode.com/problems/two-sum/',
	'https://leetcode.cn/problems/',
	'/post/hello',
	'/posts'
];

describe('spec 3.4 embed decision', () => {
	it('covers the closed 18-id enumeration', () => {
		expect(EMBED_PROVIDER_IDS).toHaveLength(18);
		const covered = new Set(Object.values(POSITIVES));
		for (const id of EMBED_PROVIDER_IDS) {
			expect(covered.has(id), `missing positive case for ${id}`).toBe(true);
		}
	});

	it('matches every registry id on its canonical shape', () => {
		for (const [url, id] of Object.entries(POSITIVES)) {
			expect(providerOf(url), url).toBe(id);
		}
	});

	it('rejects near misses (exact domain and path shaped)', () => {
		for (const url of NEGATIVES) {
			expect(providerOf(url), url).toBe('generic');
		}
	});

	it('keeps the extension list closed and case-insensitive', () => {
		for (const extension of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']) {
			expect(
				imageExtension(`https://example.com/a.${extension.toUpperCase()}?v=1#h`),
				extension
			).toBe(extension);
		}
		expect(imageExtension('https://example.com/a.tiff')).toBe('tiff');
		expect(imageExtension('https://example.com/no-extension')).toBeNull();
	});

	it('short-circuits in the spec order', () => {
		expect(decideImage({ url: 'https://github.com/foo/bar', tailAttrs: 'type=image' })).toEqual({
			kind: 'image'
		});
		expect(decideImage({ url: 'https://github.com/foo/bar', inImageContainer: true })).toEqual({
			kind: 'image'
		});
		expect(decideImage({ url: 'https://github.com/foo/bar/raw/pic.png' })).toEqual({
			kind: 'image'
		});
		// a tail spelling that is not exactly `type=image` does not apply
		expect(providerOf('https://github.com/foo/bar')).toBe('gh-repo');
		expect(decideImage({ url: 'https://github.com/foo/bar', tailAttrs: 'type=images' })).toEqual({
			kind: 'embed',
			provider: 'gh-repo'
		});
	});

	it('derives the proxy allowlist from every provider declaration', () => {
		for (const url of Object.keys(POSITIVES)) {
			if (url.startsWith('/')) continue; // lair has no public domain
			const host = canonicalHost(new URL(url).hostname);
			expect(EMBED_PROVIDER_DOMAINS.has(host), `${url} is missing from the proxy allowlist`).toBe(
				true
			);
		}
	});
});

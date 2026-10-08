import { describe, expect, it } from 'vitest';
import { normalizeRepoUrl } from './normalize';

/**
 * T7 (plan §7): the four platforms' URL shapes - `.git` suffix, trailing
 * slash, mixed case, sub-paths, query strings - resolve to the same
 * identity; unknown domains and non-repository paths resolve to null.
 */
describe('projects normalizeRepoUrl', () => {
	it('parses GitHub repository URLs across shapes', () => {
		const expected = { provider: 'github', account: 'guangyiliushan', repo: 'reborn' };
		expect(normalizeRepoUrl('https://github.com/guangyiliushan/reborn')).toEqual(expected);
		expect(normalizeRepoUrl('https://github.com/guangyiliushan/reborn.git')).toEqual(expected);
		expect(normalizeRepoUrl('https://github.com/guangyiliushan/reborn/')).toEqual(expected);
		expect(normalizeRepoUrl('https://github.com/guangyiliushan/reborn/tree/main/src')).toEqual(
			expected
		);
		expect(normalizeRepoUrl('https://www.github.com/guangyiliushan/reborn?tab=readme')).toEqual(
			expected
		);
		expect(normalizeRepoUrl('  https://github.com/guangyiliushan/reborn  ')).toEqual(expected);
		// Case is preserved (API calls must echo the stored spelling).
		expect(normalizeRepoUrl('https://github.com/GuangYiliushan/Reborn')).toEqual({
			provider: 'github',
			account: 'GuangYiliushan',
			repo: 'Reborn'
		});
	});

	it('parses GitLab URLs including subgroup namespaces', () => {
		expect(normalizeRepoUrl('https://gitlab.com/inkscape/inkscape')).toEqual({
			provider: 'gitlab',
			account: 'inkscape',
			repo: 'inkscape'
		});
		expect(normalizeRepoUrl('https://gitlab.com/group/sub/project/-/tree/main')).toEqual({
			provider: 'gitlab',
			account: 'group/sub',
			repo: 'project'
		});
		expect(normalizeRepoUrl('https://gitlab.com/group/sub/project.git')).toEqual({
			provider: 'gitlab',
			account: 'group/sub',
			repo: 'project'
		});
	});

	it('parses Gitee and Bitbucket URLs', () => {
		expect(normalizeRepoUrl('https://gitee.com/mindspore/mindspore.git')).toEqual({
			provider: 'gitee',
			account: 'mindspore',
			repo: 'mindspore'
		});
		expect(normalizeRepoUrl('https://bitbucket.org/atlassian/python-bitbucket/')).toEqual({
			provider: 'bitbucket',
			account: 'atlassian',
			repo: 'python-bitbucket'
		});
	});

	it('rejects unknown domains, non-URLs and site surfaces', () => {
		expect(normalizeRepoUrl('https://example.com/owner/repo')).toBeNull();
		expect(normalizeRepoUrl('not a url')).toBeNull();
		expect(normalizeRepoUrl('ftp://github.com/owner/repo')).toBeNull();
		expect(normalizeRepoUrl('https://github.com/owner')).toBeNull();
		expect(normalizeRepoUrl('https://github.com/settings/profile')).toBeNull();
		expect(normalizeRepoUrl('https://github.com/marketplace/actions')).toBeNull();
		// A `.git`-only segment is not a repository.
		expect(normalizeRepoUrl('https://github.com/owner/.git')).toBeNull();
	});
});

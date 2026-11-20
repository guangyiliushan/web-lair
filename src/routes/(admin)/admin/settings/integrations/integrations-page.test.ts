import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/**
 * Integrations is a planned/read-only capability map. The page groups GitHub rich
 * cards, planned rich cards (TMDB/Bangumi/NeoDB) and static embeds
 * (arXiv/LeetCode/NetEase/QQ), reports the one real status fact, and ships no control
 * that could pretend to write: no action, no form, no token field, no Save.
 *
 * The load is executed for real (only authz and the env module are faked) so a
 * regression that returns the token alongside the boolean fails here.
 */
const { envState, authzMock } = vi.hoisted(() => ({
	envState: { env: {} as Record<string, string | undefined> },
	authzMock: { requireAdminRole: vi.fn(async () => {}) }
}));

vi.mock('$env/dynamic/private', () => envState);
vi.mock('$lib/server/authz', () => authzMock);

import { load } from './+page.server';

const PAGE = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('./+page.server.ts', import.meta.url), 'utf8');
const ENV_EXAMPLE = readFileSync(
	new URL('../../../../../../.env.example', import.meta.url),
	'utf8'
);

async function runLoad(): Promise<Record<string, unknown>> {
	return (
		(await (load as unknown as (event: unknown) => Promise<Record<string, unknown>>)({})) ?? {}
	);
}

describe('Integrations page', () => {
	it('renders the three capability groups', () => {
		expect(PAGE).toContain('admin_settings_integrations_rich_group');
		expect(PAGE).toContain('admin_settings_integrations_planned_group');
		expect(PAGE).toContain('admin_settings_integrations_static_group');
		for (const label of ['TMDB', 'Bangumi', 'NeoDB', 'arXiv', 'LeetCode', 'NetEase', 'QQ']) {
			expect(PAGE).toContain(`label="${label}"`);
		}
		// The old single "Music" row is gone: the static group names the two
		// real providers instead of one vague bucket.
		expect(PAGE).not.toContain('label="Music"');
	});

	it('carries no action, form, input or submit - only status rows', () => {
		// Strip comments first: the explanatory comments above the groups
		// mention GITHUB_TOKEN and must not mask a real control.
		const markup = PAGE.replace(/<!--[\s\S]*?-->/g, '');
		expect(markup).not.toMatch(/<(?:form|input|button|select|textarea)\b/i);
		expect(markup).not.toContain('type="submit"');
		expect(markup).not.toContain('method="POST"');
		expect(markup).not.toContain('action=');
		expect(markup).not.toContain('<Button');
	});

	it('returns exactly one boolean and never the token value', async () => {
		authzMock.requireAdminRole.mockClear();

		envState.env = { GITHUB_TOKEN: '  ghp_secret_value  ' };
		const configured = await runLoad();
		expect(authzMock.requireAdminRole).toHaveBeenCalledTimes(1);
		expect(Object.keys(configured)).toEqual(['githubConfigured']);
		expect(configured.githubConfigured).toBe(true);
		expect(JSON.stringify(configured)).not.toContain('ghp_secret_value');

		envState.env = { GITHUB_TOKEN: '   ' };
		expect(await runLoad()).toEqual({ githubConfigured: false });

		envState.env = {};
		expect(await runLoad()).toEqual({ githubConfigured: false });

		// The page must not read the settings option store.
		expect(SERVER).not.toContain('getOption');
	});

	it('documents GITHUB_TOKEN apart from the other two GitHub credentials', () => {
		const start = ENV_EXAMPLE.indexOf('Three scopes');
		const end = ENV_EXAMPLE.indexOf('# Google OAuth');
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		// Phrases are matched on comment-prefix-stripped, whitespace-collapsed
		// text: the prose wraps at the comment width budget and a phrase split
		// across lines is still the same documentation contract.
		const block = ENV_EXAMPLE.slice(start, end).replace(/^#\s?/gm, '').replace(/\s+/g, ' ');
		expect(block).toContain('GITHUB_CLIENT_ID/SECRET');
		expect(block).toContain('GITHUB_TOKEN=""');
		expect(block).toContain('PROJECTS_GITHUB_TOKEN');
		expect(block).toContain('/api/embed-meta');
		expect(block).toContain('only reports whether it is set');
		expect(block).toContain('60 req/h');
		expect(block).toContain('5,000/h');

		// The projects section points back at the embed token, so the three
		// scopes cannot be confused in either direction.
		const projects = ENV_EXAMPLE.slice(ENV_EXAMPLE.indexOf('Projects sync (projects line'))
			.replace(/^#\s?/gm, '')
			.replace(/\s+/g, ' ');
		expect(projects).toContain('PROJECTS_GITHUB_TOKEN');
		expect(projects).toContain('embed uses GITHUB_TOKEN');
	});
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * W10.1 acceptance: Integrations is a planned/read-only capability map
 * (decision register §3G). The page groups GitHub rich cards, planned rich
 * cards (TMDB/Bangumi/NeoDB) and static embeds (arXiv/LeetCode/NetEase/QQ),
 * reports the one real status fact, and ships no control that could pretend to
 * write: no action, no form, no token field, no Save.
 *
 * The load may only expose a boolean derived from `env.GITHUB_TOKEN` - the
 * secret itself never crosses to the client.
 */
const PAGE = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('./+page.server.ts', import.meta.url), 'utf8');
const ENV_EXAMPLE = readFileSync(
	new URL('../../../../../../.env.example', import.meta.url),
	'utf8'
);

describe('Integrations page (W10.1)', () => {
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
		const markup = PAGE.replace(/<!--[\s\S]*?-->/g, '');
		expect(markup).not.toContain('<form');
		expect(markup).not.toContain('<input');
		expect(markup).not.toContain('type="submit"');
		expect(markup).not.toContain('method="POST"');
		expect(markup).not.toContain('action=');
		expect(markup).not.toContain('<Button');
		// Save labels/toggles never come back.
		expect(markup).not.toMatch(/token|toggle|api key/i);
	});

	it('reads the token as a boolean and never returns the secret', () => {
		expect(SERVER).toContain('requireAdminRole');
		expect(SERVER).toContain('Boolean(env.GITHUB_TOKEN?.trim())');
		expect(SERVER).not.toContain('getOption');
		expect(SERVER).not.toContain('data.settings');
	});

	it('documents GITHUB_TOKEN apart from the other two GitHub credentials', () => {
		const block = ENV_EXAMPLE.slice(ENV_EXAMPLE.indexOf('GITHUB_CLIENT_ID'));
		expect(block).toContain('GITHUB_TOKEN=""');
		expect(block).toContain('GITHUB_CLIENT_ID/SECRET');
		expect(block).toContain('PROJECTS_GITHUB_TOKEN');
		expect(block).toContain('60 req/h');
		expect(block).toContain('5,000 req/h');
		expect(block).toContain('Never stored in');
	});
});

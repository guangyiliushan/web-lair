import { describe, expect, it } from 'vitest';
import {
	AGENT_SETTING_KEYS,
	AGENT_SETTING_TIERS,
	agentSettingTier,
	agentWriteDenial
} from './setting-tiers';

/**
 * Agent setting tiers (W5.4 / decision §3A.4). The language pair is
 * read-only for the agent because `default_lang ∈ enabled` is a two-key
 * invariant only the Site page's transaction can hold; a single-key proposal
 * would be able to break it.
 */
describe('agent setting tiers (W5.4)', () => {
	it('lists the site keys but marks the language pair read-only', () => {
		expect(AGENT_SETTING_KEYS).toContain('site.info');
		expect(AGENT_SETTING_KEYS).toContain('site.languages');
		expect(AGENT_SETTING_KEYS).toContain('site.default_lang');
		expect(AGENT_SETTING_TIERS['site.languages']).toBe('read');
		expect(AGENT_SETTING_TIERS['site.default_lang']).toBe('read');
		expect(agentSettingTier('site.info')).toBe('tier1');
		expect(agentSettingTier('site.timezone')).toBe('tier1');
	});

	it('keeps the favicon out of the agent allowlist', () => {
		expect(AGENT_SETTING_KEYS as readonly string[]).not.toContain('site.icon');
		expect(agentWriteDenial('site.icon', 'owner')).toBe('not_allowlisted');
	});

	it('refuses every language-pair proposal, owner included', () => {
		for (const role of ['owner', 'admin'] as const) {
			expect(agentWriteDenial('site.languages', role)).toBe('read_only');
			expect(agentWriteDenial('site.default_lang', role)).toBe('read_only');
		}
	});

	it('still allows tier1 proposals for admins and gates tier2 to the owner', () => {
		expect(agentWriteDenial('site.info', 'admin')).toBeNull();
		expect(agentWriteDenial('site.timezone', 'admin')).toBeNull();
		expect(agentWriteDenial('ai.budget', 'admin')).toBe('owner_required');
		expect(agentWriteDenial('ai.budget', 'owner')).toBeNull();
	});

	it('denies unknown keys by default', () => {
		expect(agentWriteDenial('site.unknown', 'owner')).toBe('not_allowlisted');
		expect(agentSettingTier('site.unknown')).toBe('read');
	});
});

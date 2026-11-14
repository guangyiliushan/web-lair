/**
 * Agent setting allowlist and write tiers (AI-v3 Q3; revised by decision
 * register §3A.4, W5.4).
 *
 * The agent may read every allowlisted value. Writes are split:
 *   - `tier1` - proposal allowed for any admin, human confirmation required
 *   - `tier2` - proposal limited to the owner, human confirmation required
 *   - `read`  - no proposal at all (the value is read, never written)
 *
 * `site.languages` / `site.default_lang` are `read`: they are a paired
 * invariant (`default_lang ∈ enabled`) owned by the Site page's single
 * transaction. A single-key agent proposal cannot express the pair, so it is
 * refused rather than half-applied. `site.icon` is deliberately NOT in the
 * allowlist (favicon URLs are a browser-visible surface, not agent fodder).
 */
export const AGENT_SETTING_KEYS = [
	'site.info',
	'site.timezone',
	'site.languages',
	'site.default_lang',
	'presence.enabled',
	'notes.gate',
	'ai.styleGuide',
	'ai.summary',
	'ai.translation',
	'ai.crawl',
	'comments.moderation',
	'ai.assignments',
	'ai.budget',
	'ai.pricing'
] as const;

export type AgentSettingKey = (typeof AGENT_SETTING_KEYS)[number];
export type AgentSettingTier = 'read' | 'tier1' | 'tier2';

export const AGENT_SETTING_TIERS: Record<AgentSettingKey, AgentSettingTier> = {
	'site.info': 'tier1',
	'site.timezone': 'tier1',
	'site.languages': 'read',
	'site.default_lang': 'read',
	'presence.enabled': 'tier1',
	'notes.gate': 'tier1',
	'ai.styleGuide': 'tier1',
	'ai.summary': 'tier1',
	'ai.translation': 'tier1',
	'ai.crawl': 'tier1',
	'comments.moderation': 'tier1',
	'ai.assignments': 'tier2',
	'ai.budget': 'tier2',
	'ai.pricing': 'tier2'
};

/** Unknown keys are treated as `read` (deny by default). */
export function agentSettingTier(key: string): AgentSettingTier {
	return (AGENT_SETTING_TIERS as Record<string, AgentSettingTier>)[key] ?? 'read';
}

export type AgentWriteDenial = 'not_allowlisted' | 'read_only' | 'owner_required' | null;

/**
 * Why a proposal for `key` must be refused for `role`, or null when it is
 * allowed to create a pending proposal. Read-only keys are refused for every
 * role (owner included): the invariant belongs to the settings surface.
 */
export function agentWriteDenial(key: string, role: 'owner' | 'admin'): AgentWriteDenial {
	if (!(AGENT_SETTING_KEYS as readonly string[]).includes(key)) return 'not_allowlisted';
	const tier = agentSettingTier(key);
	if (tier === 'read') return 'read_only';
	if (tier === 'tier2' && role !== 'owner') return 'owner_required';
	return null;
}

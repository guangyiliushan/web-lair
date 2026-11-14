/**
 * Admin-assistant setting allowlist (agent v1, AI-v3 Q1/Q3; W6.9 / C8).
 *
 * Kept in its own module so the boundary has a dependency-light home: the
 * agent tools module drags in the database, markdown renderer and draft
 * services, none of which a permission test should need.
 *
 * Rules:
 *   - the assistant only reads/writes keys listed here;
 *   - comment privacy, the new comment/friends keys and the contract-only
 *     payments flag are deliberately absent (owner control plane / no
 *     consumer);
 *   - presence.enabled and notes.gate stay tier1: the register records the
 *     deliberate dual-write (agent proposal + settings page, last write wins).
 */
export const SETTING_KEYS = [
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

export type AgentSettingKey = (typeof SETTING_KEYS)[number];

export const SETTING_TIERS: Record<string, 'read' | 'tier1' | 'tier2'> = {
	'site.info': 'tier1',
	'site.timezone': 'tier1',
	'site.languages': 'tier2',
	'site.default_lang': 'tier2',
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

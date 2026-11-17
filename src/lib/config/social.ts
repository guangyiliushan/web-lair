import { m } from '$lib/paraglide/messages';

/**
 * Social links: one preset table for validation, rendering and the settings
 * form. `user_profiles.links` is the single source for the
 * owner's social accounts; the RSS feed is a fixed rail item supplied by code,
 * never stored in `links`, never deletable and never re-ordered by the owner.
 */
export const SOCIAL_USER_PLATFORMS = [
	'github',
	'x',
	'telegram',
	'email',
	'bilibili',
	'zhihu',
	'youtube'
] as const;

export type SocialUserPlatform = (typeof SOCIAL_USER_PLATFORMS)[number];
export type SocialRailPlatform = SocialUserPlatform | 'rss';

export interface SocialPreset {
	/** Accepted registrable hosts; empty for schemes that carry no host. */
	hosts: readonly string[];
	label: () => string;
}

export const SOCIAL_PRESETS: Record<SocialUserPlatform, SocialPreset> = {
	github: { hosts: ['github.com'], label: m.social_github },
	x: { hosts: ['x.com', 'twitter.com'], label: m.social_x },
	telegram: { hosts: ['t.me', 'telegram.me'], label: m.social_telegram },
	email: { hosts: [], label: m.social_email },
	bilibili: { hosts: ['bilibili.com', 'b23.tv'], label: m.social_bilibili },
	zhihu: { hosts: ['zhihu.com'], label: m.social_zhihu },
	youtube: { hosts: ['youtube.com', 'youtu.be'], label: m.social_youtube }
};

/** Fixed rail item: rendered with the owner's socials, outside the 8-link cap. */
export const SOCIAL_RAIL_FIXED = [{ platform: 'rss', href: '/rss.xml' }] as const;

export const SOCIAL_RSS_LABEL = (): string => m.social_rss();

/** Structural shape shared with `user_profiles.links` without importing drizzle. */
export interface SocialLinkLike {
	platform: string;
	href: string;
	label?: string;
}

export interface SocialRailItem {
	platform: SocialRailPlatform;
	href: string;
	label: string;
}

/** Host match allows the registrable domain and its subdomains, never suffixes. */
export function socialHostMatches(host: string, allowed: readonly string[]): boolean {
	const normalized = host.toLowerCase();
	return allowed.some((base) => normalized === base || normalized.endsWith(`.${base}`));
}

/**
 * Read-path guard: rows are validated on write, but an old/corrupt row must
 * not become a `javascript:` link or an unknown platform icon. Unknown
 * platforms are skipped with a warning; user order is preserved.
 */
export function socialRailItems(
	links: readonly SocialLinkLike[] | null | undefined
): SocialRailItem[] {
	const items: SocialRailItem[] = [];
	for (const link of links ?? []) {
		const preset = SOCIAL_PRESETS[link.platform as SocialUserPlatform];
		if (!preset) {
			console.warn('[social] unknown platform skipped', link.platform);
			continue;
		}
		const href = link.href.trim();
		if (!isSafeSocialHref(link.platform as SocialUserPlatform, href)) {
			console.warn('[social] unsafe social href skipped', link.platform);
			continue;
		}
		items.push({
			platform: link.platform as SocialUserPlatform,
			href,
			label: link.label?.trim() || preset.label()
		});
	}
	for (const fixed of SOCIAL_RAIL_FIXED) {
		items.push({ platform: fixed.platform, href: fixed.href, label: SOCIAL_RSS_LABEL() });
	}
	return items;
}

export function isSafeSocialHref(platform: SocialUserPlatform, href: string): boolean {
	if (platform === 'email') return /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(href);
	if (!href) return false;
	let parsed: URL;
	try {
		parsed = new URL(href);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'https:') return false;
	return socialHostMatches(parsed.hostname, SOCIAL_PRESETS[platform].hosts);
}

/** External links open in a new tab; internal `/rss.xml` and mailto do not. */
export function isExternalSocialHref(href: string): boolean {
	if (href.startsWith('/')) return false;
	return !href.startsWith('mailto:');
}

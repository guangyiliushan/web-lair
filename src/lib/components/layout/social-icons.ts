import type { Component } from 'svelte';
import IconBrandGithub from '@tabler/icons-svelte-runes/icons/brand-github';
import IconBrandX from '@tabler/icons-svelte-runes/icons/brand-x';
import IconBrandTelegram from '@tabler/icons-svelte-runes/icons/brand-telegram';
import IconMail from '@tabler/icons-svelte-runes/icons/mail';
import IconBrandBilibili from '@tabler/icons-svelte-runes/icons/brand-bilibili';
import IconBrandZhihu from '@tabler/icons-svelte-runes/icons/brand-zhihu';
import IconBrandYoutube from '@tabler/icons-svelte-runes/icons/brand-youtube';
import IconRss from '@tabler/icons-svelte-runes/icons/rss';
import type { SocialRailPlatform } from '$lib/config/social';

/**
 * Icon table for the one social rail (Hero / nav panel / mobile menu). Kept
 * out of `$lib/config/social.ts` so the validation/service layer does not
 * import Svelte components.
 */
export const SOCIAL_ICONS: Record<SocialRailPlatform, Component> = {
	github: IconBrandGithub,
	x: IconBrandX,
	telegram: IconBrandTelegram,
	email: IconMail,
	bilibili: IconBrandBilibili,
	zhihu: IconBrandZhihu,
	youtube: IconBrandYoutube,
	rss: IconRss
};

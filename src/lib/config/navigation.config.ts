import type { Component } from 'svelte';
import {
	IconHome,
	IconBulb,
	IconCategory,
	IconRss,
	IconMail,
	IconBrandGithub,
	IconBrandTwitter,
	IconUsers,
	IconFlask,
	IconQuote,
	IconWorld,
	IconPencil,
	IconBook,
	IconCamera,
	IconHeart,
	IconWriting
} from '@tabler/icons-svelte-runes';
import { m } from '$lib/paraglide/messages';

// ── i18n resolver ──

const t = {
	nav_home: m.nav_home,
	nav_posts: m.nav_posts,
	nav_notes: m.nav_notes,
	nav_timeline: m.nav_timeline,
	nav_moments: m.nav_moments,
	nav_more: m.nav_more,
	nav_about: m.nav_about,
	nav_home_quick_links: m.nav_home_quick_links,
	nav_home_rss: m.nav_home_rss,
	nav_home_rss_desc: m.nav_home_rss_desc,
	nav_home_github: m.nav_home_github,
	nav_home_github_desc: m.nav_home_github_desc,
	nav_home_twitter: m.nav_home_twitter,
	nav_home_twitter_desc: m.nav_home_twitter_desc,
	nav_home_email: m.nav_home_email,
	nav_home_email_desc: m.nav_home_email_desc,
	nav_more_friends: m.nav_more_friends,
	nav_more_friends_desc: m.nav_more_friends_desc,
	nav_more_photos: m.nav_more_photos,
	nav_more_photos_desc: m.nav_more_photos_desc,
	nav_more_projects: m.nav_more_projects,
	nav_more_projects_desc: m.nav_more_projects_desc,
	nav_more_quotes: m.nav_more_quotes,
	nav_more_quotes_desc: m.nav_more_quotes_desc,
	nav_more_thoughts: m.nav_more_thoughts,
	nav_more_thoughts_desc: m.nav_more_thoughts_desc,
	nav_more_warp: m.nav_more_warp,
	nav_more_warp_desc: m.nav_more_warp_desc,
	nav_posts_categories: m.nav_posts_categories,
	nav_posts_recent: m.nav_posts_recent,
	nav_posts_view_all: m.nav_posts_view_all,
	nav_notes_series: m.nav_notes_series,
	nav_notes_recent: m.nav_notes_recent,
	nav_notes_view_all: m.nav_notes_view_all,
	nav_timeline_notes: m.nav_timeline_notes,
	nav_timeline_posts: m.nav_timeline_posts,
	nav_timeline_memories: m.nav_timeline_memories,
	nav_timeline_recent: m.nav_timeline_recent,
	nav_timeline_view_all: m.nav_timeline_view_all,
	nav_home_here: m.nav_home_here,
	nav_home_owner_online: m.nav_home_owner_online,
	nav_home_stat_posts: m.nav_home_stat_posts,
	nav_home_stat_notes: m.nav_home_stat_notes,
	nav_home_stat_topics: m.nav_home_stat_topics,
	nav_notes_all_series: m.nav_notes_all_series,
	nav_menu_empty: m.nav_menu_empty
} as const;

type I18nKey = keyof typeof t;

export type { I18nKey };

/** Resolve i18n key → translated string */
export function tLabel(key: I18nKey): string {
	return t[key]();
}

// ── Types ──

export interface NavChild {
	labelKey?: I18nKey;
	label?: string; // Literal override for dynamic server data
	href: string;
	/**
	 * Stable unique key for keyed-each menus. Hrefs are NOT unique across a
	 * merged list (two rows may share an external_url, or a row may repeat a
	 * static quick link) and Svelte throws `each_key_duplicate` in production
	 * too. Pages rows pass their slug.
	 */
	key?: string;
	descKey?: I18nKey;
	desc?: string; // Literal fallback for descriptions/dates
	/** Static config only: components cannot cross the load serialisation
	 * boundary - dynamic server items use `iconName` (nav-icons.ts). */
	icon?: Component;
	/** Whitelist icon for dynamic server data (see $lib/config/nav-icons). */
	iconName?: string;
	/** Static config only (same serialisation rule as `icon`). */
	imageUrl?: string; // Thumbnail image (e.g., series icons)
	badge?: string | number;
	/** Password-gated note marker on dynamic items. */
	locked?: boolean;
}

export interface NavColumn {
	titleKey?: I18nKey;
	items: NavChild[];
}

export interface NavFooter {
	labelKey: I18nKey;
	href: string;
	/** Trailing link on the opposite side of the footer (e.g. "All topics"). */
	secondary?: { labelKey: I18nKey; href: string };
}

export type NavMenuKind = 'home' | 'two-column' | 'simple';

export interface NavMenuConfig {
	type?: NavMenuKind; // defaults to 'simple'
	width?: string;
	columns: NavColumn[];
	rightColumn?: NavColumn; // For two-column layout (e.g., Recent Notes)
	footer?: NavFooter;
}

export interface NavItem {
	key: string;
	labelKey: I18nKey;
	href: string;
	icon?: Component;
	megaMenu?: NavMenuConfig;
	children?: NavChild[];
}

// ── Dynamic server data for the nav panels ──

/**
 * Live counts for the home panel's stat strip. Deliberately a fixed triple —
 * the layout is a three-row list, so an open-ended record would only invite
 * rows nobody renders.
 */
export interface NavMenuStats {
	posts: number;
	notes: number;
	topics: number;
}

/** Runtime data passed to NavMenu to fill two-column/timeline layouts */
export interface NavMenuData {
	leftItems: NavChild[];
	rightItems: NavChild[];
	footerSecondaryText?: string;
	/**
	 * Counts this loader happens to know. Loaders run in parallel and each owns
	 * a different aggregate, so the shape is partial on purpose — the home panel
	 * zero-fills whatever is missing rather than forcing a second pass over the
	 * same tables.
	 */
	stats?: Partial<NavMenuStats>;
}

/** Chrome payload for the pages surface (P1b): menu items + footer defaults. */
export interface PagesMegaData extends NavMenuData {
	/** `is_default` rows (footer About group); same single query as the items. */
	footerDefaults: { label: string; href: string; key?: string }[];
}

// ── Single data source ──

export const navigationConfig: NavItem[] = [
	{
		key: 'nav_home',
		labelKey: 'nav_home',
		href: '/',
		icon: IconHome,
		megaMenu: {
			type: 'home',
			width: 'w-[520px]',
			columns: [
				{
					titleKey: 'nav_home_quick_links',
					items: [
						{
							labelKey: 'nav_home_rss',
							href: '/rss.xml',
							descKey: 'nav_home_rss_desc',
							icon: IconRss
						},
						{
							labelKey: 'nav_home_github',
							href: 'https://github.com/guangyiliushan',
							descKey: 'nav_home_github_desc',
							icon: IconBrandGithub
						},
						{
							labelKey: 'nav_home_twitter',
							href: 'https://twitter.com/guangyiliushan',
							descKey: 'nav_home_twitter_desc',
							icon: IconBrandTwitter
						},
						{
							labelKey: 'nav_home_email',
							href: 'mailto:guangyiliushan@example.com',
							descKey: 'nav_home_email_desc',
							icon: IconMail
						}
					]
				}
			]
		},
		children: [
			{ labelKey: 'nav_home_rss', href: '/rss.xml', icon: IconRss },
			{
				labelKey: 'nav_home_github',
				href: 'https://github.com/guangyiliushan',
				icon: IconBrandGithub
			},
			{
				labelKey: 'nav_home_twitter',
				href: 'https://twitter.com/guangyiliushan',
				icon: IconBrandTwitter
			},
			{ labelKey: 'nav_home_email', href: 'mailto:guangyiliushan@example.com', icon: IconMail }
		]
	},
	{
		key: 'nav_posts',
		labelKey: 'nav_posts',
		href: '/posts',
		icon: IconHome,
		megaMenu: {
			type: 'two-column',
			width: 'w-[520px]',
			columns: [
				{
					titleKey: 'nav_posts_categories',
					items: [] // filled by server data
				}
			],
			rightColumn: {
				titleKey: 'nav_posts_recent',
				items: [] // filled by server data
			},
			footer: {
				labelKey: 'nav_posts_view_all',
				href: '/posts'
			}
		},
		children: [{ labelKey: 'nav_posts_view_all', href: '/posts' }]
	},
	{
		key: 'nav_notes',
		labelKey: 'nav_notes',
		href: '/notes',
		icon: IconHome,
		megaMenu: {
			type: 'two-column',
			width: 'w-[520px]',
			columns: [
				{
					titleKey: 'nav_notes_series',
					items: [] // filled by server data
				}
			],
			rightColumn: {
				titleKey: 'nav_notes_recent',
				items: [] // filled by server data
			},
			footer: {
				labelKey: 'nav_notes_view_all',
				href: '/notes',
				secondary: { labelKey: 'nav_notes_all_series', href: '/notes/topics' }
			}
		},
		children: [{ labelKey: 'nav_notes_view_all', href: '/notes' }]
	},
	{
		key: 'nav_moments',
		labelKey: 'nav_moments',
		href: '/moments',
		icon: IconWriting
	},
	{
		key: 'nav_timeline',
		labelKey: 'nav_timeline',
		href: '/timeline',
		icon: IconHome,
		megaMenu: {
			type: 'two-column',
			width: 'w-[520px]',
			columns: [
				{
					items: [
						{ labelKey: 'nav_timeline_notes', href: '/timeline?type=note', icon: IconPencil },
						{ labelKey: 'nav_timeline_posts', href: '/timeline?type=post', icon: IconBook },
						{ labelKey: 'nav_timeline_memories', href: '/timeline?memory=1', icon: IconHeart }
					]
				}
			],
			rightColumn: { titleKey: 'nav_timeline_recent', items: [] },
			footer: {
				labelKey: 'nav_timeline_view_all',
				href: '/timeline'
			}
		},
		children: [{ labelKey: 'nav_timeline_view_all', href: '/timeline' }]
	},
	{
		key: 'nav_more',
		labelKey: 'nav_more',
		href: '#',
		icon: IconCategory,
		megaMenu: {
			type: 'simple',
			width: 'w-[320px]',
			columns: [
				{
					items: [
						{
							labelKey: 'nav_more_friends',
							href: '/friends',
							descKey: 'nav_more_friends_desc',
							icon: IconUsers
						},
						{
							labelKey: 'nav_more_projects',
							href: '/projects',
							descKey: 'nav_more_projects_desc',
							icon: IconFlask
						},
						{
							labelKey: 'nav_more_photos',
							href: '/photos',
							descKey: 'nav_more_photos_desc',
							icon: IconCamera
						},
						{
							labelKey: 'nav_more_quotes',
							href: '/quotes',
							descKey: 'nav_more_quotes_desc',
							icon: IconQuote
						},
						{
							labelKey: 'nav_more_thoughts',
							href: '/thoughts',
							descKey: 'nav_more_thoughts_desc',
							icon: IconBulb
						},
						{
							labelKey: 'nav_more_warp',
							href: 'https://travel.moe/go.html',
							descKey: 'nav_more_warp_desc',
							icon: IconWorld
						}
					]
				}
			]
		},
		children: [
			{ labelKey: 'nav_more_friends', href: '/friends' },
			{ labelKey: 'nav_more_projects', href: '/projects' },
			{ labelKey: 'nav_more_photos', href: '/photos' },
			{ labelKey: 'nav_more_quotes', href: '/quotes' },
			{ labelKey: 'nav_more_thoughts', href: '/thoughts' },
			{ labelKey: 'nav_more_warp', href: 'https://travel.moe/go.html' }
		]
	}
];

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
	nav_timeline_view_all: m.nav_timeline_view_all
} as const;

type I18nKey = keyof typeof t;

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
}

export type MegaMenuType = 'home' | 'two-column' | 'simple' | 'timeline';

export interface MegaMenu {
	type?: MegaMenuType; // defaults to 'simple'
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
	megaMenu?: MegaMenu;
	children?: NavChild[];
}

// ── Dynamic server data for mega menus ──

/** Runtime data passed to NavMegaMenu to fill two-column/timeline layouts */
export interface MegaMenuDynamicData {
	leftItems: NavChild[];
	rightItems: NavChild[];
	footerSecondaryText?: string;
	/** Timeline activity items (for type='timeline') */
	timelineItems?: TimelineActivityItem[];
}

export interface TimelineActivityItem {
	title: string;
	href: string;
	type: 'posts' | 'notes' | 'memories';
	date: string;
	/** Password-gated note marker (N1). */
	locked?: boolean;
}

/** Chrome payload for the pages surface (P1b): menu items + footer defaults. */
export interface PagesMegaData extends MegaMenuDynamicData {
	/** `is_default` rows (footer About group); same single query as the items. */
	footerDefaults: { label: string; href: string; key?: string }[];
}

/**
 * Home menu order (F1, P1b): dynamic page entries (defaults → extras) first,
 * the static quick links stay as a trailing group.
 */
export function mergeHomeMenuItems(
	dynamic: NavChild[] | null | undefined,
	fixed: NavChild[]
): NavChild[] {
	return [...(dynamic ?? []), ...fixed];
}

export interface MegaMenuCategory {
	labelKey: I18nKey;
	href: string;
	count: number;
}

export interface MegaMenuRecentPost {
	title: string;
	href: string;
	date: string;
}

export interface PostsMegaData {
	categories: MegaMenuCategory[];
	recentPosts: MegaMenuRecentPost[];
	totalCount: number;
}

export interface MegaMenuSeriesItem {
	label: string;
	href: string;
	imageUrl?: string;
}

export interface NotesMegaData {
	series: MegaMenuSeriesItem[];
	recentNotes: MegaMenuRecentPost[];
	totalCount: number;
}

export interface TimelineMegaData {
	activities: TimelineActivityItem[];
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
			width: 'w-[480px]',
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
			width: 'w-[480px]',
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
			width: 'w-[380px]',
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
				href: '/notes'
			}
		},
		children: [{ labelKey: 'nav_notes_view_all', href: '/notes' }]
	},
	{
		key: 'nav_timeline',
		labelKey: 'nav_timeline',
		href: '/timeline',
		icon: IconHome,
		megaMenu: {
			type: 'timeline',
			width: 'w-[320px]',
			columns: [
				{
					items: [
						{ labelKey: 'nav_timeline_notes', href: '/timeline?type=note', icon: IconPencil },
						{ labelKey: 'nav_timeline_posts', href: '/timeline?type=post', icon: IconBook },
						{ labelKey: 'nav_timeline_memories', href: '/timeline?memory=1', icon: IconHeart }
					]
				}
			],
			footer: {
				labelKey: 'nav_timeline_view_all',
				href: '/timeline'
			}
		},
		children: [{ labelKey: 'nav_timeline_view_all', href: '/timeline' }]
	},
	{
		key: 'nav_moments',
		labelKey: 'nav_moments',
		href: '/moments',
		icon: IconWriting
	},
	{
		key: 'nav_more',
		labelKey: 'nav_more',
		href: '#',
		icon: IconCategory,
		megaMenu: {
			type: 'simple',
			width: 'w-[280px]',
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

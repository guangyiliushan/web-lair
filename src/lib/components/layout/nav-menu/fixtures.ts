// Storybook fixtures for the nav mega panels.
//
// These mock the *data contract* (`MegaMenu` config + `NavMenuData`),
// not the render layer, so they survive the shell swap untouched.
//
// Rows use `iconName`, never `icon: Component`: dynamic menu data crosses the
// load serialisation boundary where components cannot travel (see `NavChild`).
import type { NavChild, NavMenuConfig, NavMenuData } from '$lib/config/navigation.config';

// ── Home ──

export const homeMenu: NavMenuConfig = {
	type: 'home',
	width: 'w-[520px]',
	columns: [
		{
			titleKey: 'nav_home_quick_links',
			// Socials/RSS live in `ownerLinks`; the panel rail is the only copy.
			items: []
		}
	]
};

/** Owner social links fixture; RSS is appended by SocialRail. */
export const ownerLinks = [
	{ platform: 'github', href: 'https://github.com/example' },
	{ platform: 'email', href: 'mailto:me@example.com' }
] as const;

/** Defaults → extras → quick links, the order `pages-p1b` asserts on. */
export const homeData: NavMenuData = {
	leftItems: [
		{ key: 'about', label: 'About', href: '/about' },
		{ key: 'about-site', label: 'About this site', href: '/about-site' },
		{ key: 'guestbook', label: 'Guestbook', href: '/guestbook' }
	],
	rightItems: [],
	stats: { posts: 369, notes: 1419, topics: 12 }
};

// ── Posts (two-column) ──

export const postsMenu: NavMenuConfig = {
	type: 'two-column',
	width: 'w-[520px]',
	columns: [
		{
			titleKey: 'nav_posts_categories',
			items: []
		}
	],
	rightColumn: { titleKey: 'nav_posts_recent', items: [] },
	footer: { labelKey: 'nav_posts_view_all', href: '/posts' }
};

const category = (label: string, href: string, count: number, iconName?: string): NavChild => ({
	label,
	href,
	badge: count,
	iconName
});

export const postsData: NavMenuData = {
	leftItems: [
		category('Essay', '/posts?category=essay', 24, 'feather'),
		category('Notes on tools', '/posts?category=tools', 11, 'code'),
		category('Photography', '/posts?category=photo', 7, 'camera'),
		category('Long walks', '/posts?category=walks', 3, 'leaf')
	],
	rightItems: [
		{
			label: 'On keeping a garden of notes',
			href: '/posts/garden-of-notes',
			desc: '2026-10-19'
		},
		{
			label: 'Why I stopped chasing the perfect stack',
			href: '/posts/perfect-stack',
			desc: '2026-10-11'
		},
		{
			label: 'A short history of this site',
			href: '/posts/site-history',
			desc: '2026-09-30'
		}
	],
	footerSecondaryText: '369 posts'
};

// ── Notes (two-column) ──

export const notesMenu: NavMenuConfig = {
	type: 'two-column',
	width: 'w-[520px]',
	columns: [{ titleKey: 'nav_notes_series', items: [] }],
	rightColumn: { titleKey: 'nav_notes_recent', items: [] },
	footer: { labelKey: 'nav_notes_view_all', href: '/notes' }
};

export const notesData: NavMenuData = {
	leftItems: [
		{ label: 'Field notes', href: '/notes?series=field', iconName: 'notebook', badge: 42 },
		{ label: 'Kitchen table', href: '/notes?series=kitchen', iconName: 'coffee', badge: 18 },
		{ label: 'Half-formed', href: '/notes?series=half', iconName: 'bulb', badge: 9 }
	],
	rightItems: [
		{ label: 'Rain on the window again', href: '/notes/rain', desc: '10·19' },
		{ label: 'Three things I re-learned this week', href: '/notes/three-things', desc: '10·12' },
		{ label: 'A locked one', href: '/notes/locked', desc: '09·28', locked: true }
	],
	footerSecondaryText: '1419 notes'
};

// ── Edge cases ──

/** Server data has not resolved yet — the panel must still render. */
export const emptyData: NavMenuData = { leftItems: [], rightItems: [] };

/**
 * Long / mixed-script labels: the reason the right column is `min-w-0` and
 * every row truncates. Verified in three scripts because the site ships
 * en / zh-cn / ja.
 */
export const longTitleData: NavMenuData = {
	leftItems: [
		{
			label: 'A category name that is far longer than any column can hold',
			href: '/posts?category=very-long',
			badge: 1
		},
		{
			label: '手记系列：一个特别特别长的专栏名称用来测试截断',
			href: '/notes?series=long-zh',
			badge: 2
		},
		{
			label: 'とても長いシリーズ名前がここに折り返されないことを確認する',
			href: '/notes?series=long-ja',
			badge: 3
		}
	],
	rightItems: [
		{
			label: 'An English recent-item title that will not fit the 44px date column beside it',
			href: '/posts/long-en',
			desc: '2026-10-19'
		},
		{
			label: '中文最近条目标题：同样需要在右侧单行内截断，不应撑开面板',
			href: '/notes/long-zh',
			desc: '10·19'
		}
	],
	footerSecondaryText: '1419 notes',
	stats: { posts: 369, notes: 1419, topics: 12 }
};

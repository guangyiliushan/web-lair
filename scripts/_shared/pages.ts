// Shared constants for the protected default pages (pages line P0 / plan
// §2.6). Single source of truth for `db:ensure-pages` and `db:verify-pages`.

export const DEFAULT_PAGE_SLUGS = ['about', 'about-site'] as const;

export type SeedPage = {
	slug: (typeof DEFAULT_PAGE_SLUGS)[number];
	title: Partial<Record<'en' | 'zh-cn' | 'ja', string>>;
	description: Partial<Record<'en' | 'zh-cn' | 'ja', string>>;
	markdown: Partial<Record<'en' | 'zh-cn' | 'ja', string>>;
};

export const SEED_PAGES: SeedPage[] = [
	{
		slug: 'about',
		title: { en: 'About Me', 'zh-cn': '关于我', ja: '自己紹介' },
		description: {
			en: 'A short introduction to the author.',
			'zh-cn': '作者的简短介绍。',
			ja: '運営者の紹介です。'
		},
		markdown: {
			en: '# About Me\\n\\nThis page is ready to edit.',
			'zh-cn': '# 关于我\\n\\n这个页面可以直接编辑。',
			ja: '# 自己紹介\\n\\nこのページは編集できます。'
		}
	},
	{
		slug: 'about-site',
		title: { en: 'About This Project', 'zh-cn': '关于本项目', ja: 'このプロジェクトについて' },
		description: {
			en: 'What Web Lair is and how it is built.',
			'zh-cn': 'Web Lair 是什么，以及它如何构建。',
			ja: 'Web Lair の概要と構成です。'
		},
		markdown: {
			en: '# About This Project\\n\\nWeb Lair is a self-hosted publishing project.',
			'zh-cn': '# 关于本项目\\n\\nWeb Lair 是一个自托管发布项目。',
			ja: '# このプロジェクトについて\\n\\nWeb Lair はセルフホストの公開プロジェクトです。'
		}
	}
];

import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('DATABASE_URL is required.');
	process.exit(1);
}

type LocalizedText = Partial<Record<'en' | 'zh-cn' | 'ja', string>>;

type SeedPage = {
	slug: string;
	title: LocalizedText;
	description: LocalizedText;
	markdown: LocalizedText;
};

const SEED_PAGES: SeedPage[] = [
	{
		slug: 'about',
		title: { en: 'About Me', 'zh-cn': '关于我', ja: '自己紹介' },
		description: {
			en: 'A short introduction to the author.',
			'zh-cn': '作者的简短介绍。',
			ja: '運営者の紹介です。'
		},
		markdown: {
			en: '# About Me\n\nThis page is ready to edit.',
			'zh-cn': '# 关于我\n\n这个页面可以直接编辑。',
			ja: '# 自己紹介\n\nこのページは編集できます。'
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
			en: '# About This Project\n\nWeb Lair is a self-hosted publishing project.',
			'zh-cn': '# 关于本项目\n\nWeb Lair 是一个自托管发布项目。',
			ja: '# このプロジェクトについて\n\nWeb Lair はセルフホストの公開プロジェクトです。'
		}
	}
];

/**
 * Seeds only the two protected defaults. Re-running never overwrites user
 * edits; editability is owned by the P5 admin/editor flow.
 */
async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		for (const seed of SEED_PAGES) {
			await sql`
				insert into pages (
					slug, title, description, icon, external_url, status,
					sort_order, is_default, content, content_format
				) values (
					${seed.slug},
					${sql.json(seed.title)},
					${sql.json(seed.description)},
					null,
					null,
					'visible',
					${seed.slug === 'about' ? 1 : 2},
					true,
					${sql.json(seed.markdown)},
					'markdown'
				)
				on conflict (slug) do nothing
			`;
		}

		const rows = await sql`
			select slug
			from pages
			where is_default and slug in ('about', 'about-site')
			order by slug
		`;
		if (rows.length !== SEED_PAGES.length) {
			const detail = await sql`
				select slug, is_default, status
				from pages
				where slug in ('about', 'about-site')
				order by slug
			`;
			const present =
				detail
					.map((row) => `${row.slug}(is_default=${row.is_default}, status=${row.status})`)
					.join(', ') || 'none';
			throw new Error(
				`Expected ${SEED_PAGES.length} protected defaults, found ${rows.length}. Present: ${present}.`
			);
		}
		console.log(`✓ ensured pages: ${rows.map((row) => row.slug).join(', ')}`);
	} finally {
		await sql.end();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});

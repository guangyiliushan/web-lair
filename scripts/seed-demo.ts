// scripts/seed-demo.ts
// 用法:
//   pnpm db:start          (首次:起数据库容器)
//   pnpm db:migrate        (首次:建表)
//   pnpm db:seed-demo      — 幂等:已存在即跳过(已删除的文章不会被找回)
//   pnpm db:seed-demo --force — 重写演示文章的正文、标题与摘要
//
// 环境变量:
//   DATABASE_URL — PostgreSQL 连接串(.env 由 --env-file)注入)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { categories } from '../src/lib/server/db/content/category.schema';
import { posts } from '../src/lib/server/db/content/post.schema';
import { postTags, tags } from '../src/lib/server/db/content/tag.schema';
import { tagSlug } from '../src/lib/utils/slug';

const CATEGORY_SLUG = 'demo';
const CATEGORY_NAME = '示例';
const POST_SLUG = 'markdown-syntax-demo';
const POST_TITLE = 'Markdown 语法演示';
const POST_SUMMARY = '站点支持的全部 Markdown 语法;删除本文章不影响站点,种子脚本不会把它找回。';
const POST_TAGS = ['演示', 'markdown'];

const force = process.argv.includes('--force');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL?.trim()) {
	console.error('✗ DATABASE_URL is required.');
	process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(join(here, 'seed-demo', 'demo-post.md'), 'utf8').trimEnd();

async function main(): Promise<void> {
	const client = postgres(DATABASE_URL as string);
	const db = drizzle(client);

	// 分类:按 slug 查,缺则建(--force 不改分类)
	const existingCategory = await db
		.select()
		.from(categories)
		.where(eq(categories.slug, CATEGORY_SLUG))
		.limit(1);
	let categoryId: string;
	if (existingCategory.length > 0) {
		categoryId = existingCategory[0].id;
		console.log(`- category "${CATEGORY_SLUG}" exists, reusing (${categoryId})`);
	} else {
		const [created] = await db
			.insert(categories)
			.values({ name: CATEGORY_NAME, slug: CATEGORY_SLUG })
			.returning({ id: categories.id });
		categoryId = created.id;
		console.log(`+ category "${CATEGORY_NAME}" created (${categoryId})`);
	}

	// 文章:按 slug 查;存在则跳过(--force 时重写正文/标题/摘要)
	const existingPost = await db.select().from(posts).where(eq(posts.slug, POST_SLUG)).limit(1);
	if (existingPost.length > 0) {
		if (!force) {
			console.log(`= post "${POST_SLUG}" exists, skipping (use --force to rewrite)`);
		} else {
			await db
				.update(posts)
				.set({ title: POST_TITLE, content, summary: POST_SUMMARY, updatedAt: new Date() })
				.where(eq(posts.slug, POST_SLUG));
			console.log(`~ post "${POST_SLUG}" rewritten (--force)`);
		}
	} else {
		const [created] = await db
			.insert(posts)
			.values({
				title: POST_TITLE,
				slug: POST_SLUG,
				content,
				contentFormat: 'markdown',
				summary: POST_SUMMARY,
				categoryId,
				status: 'published',
				publishedAt: new Date()
			})
			.returning({ id: posts.id });
		await syncTags(db, created.id, POST_TAGS);
		console.log(`+ post "${POST_SLUG}" created`);
	}

	await client.end();
	console.log('done.');
}

async function syncTags(
	db: ReturnType<typeof drizzle>,
	postId: string,
	names: string[]
): Promise<void> {
	await db.delete(postTags).where(eq(postTags.postId, postId));
	for (const name of names) {
		const slug = tagSlug(name);
		// First-writer-wins on the display name (same rule as the editor path):
		// case/space variants must not rename an existing tag site-wide.
		const [tag] = await db
			.insert(tags)
			.values({ name, slug })
			.onConflictDoUpdate({ target: tags.slug, set: { name: sql`${tags.name}` } })
			.returning({ id: tags.id });
		await db.insert(postTags).values({ postId, tagId: tag.id }).onConflictDoNothing();
	}
}

main().catch((error: unknown) => {
	console.error('✗ seed-demo failed:', error);
	process.exit(1);
});

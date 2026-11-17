import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('DATABASE_URL is required.');
	process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Ensures the fallback category exists.
 *
 * `posts.category_id` is NOT NULL with `on delete restrict`, so a category
 * that still owns posts cannot be deleted and there is no "no category" state
 * to fall back to. The default category is that fallback: "clear out this
 * category" moves its posts here before the row goes.
 *
 * Naming follows `ensure-pages.ts`: re-running never overwrites user edits
 * (the owner may rename it), and `--dry-run` reports without writing.
 */
const DEFAULT_SLUG = 'uncategorized';
const DEFAULT_NAME = '未分类';

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		if (DRY_RUN) {
			const present = await sql`
				select slug, name, is_default
				from categories
				where is_default
			`;
			const state =
				present.map((row) => `${row.slug}(${row.name}, is_default=${row.is_default})`).join(', ') ||
				'none';
			console.log(`→ dry-run: would ensure default category; present: ${state}`);
			return;
		}

		// Idempotent: only insert when nothing is flagged yet. If the owner has
		// already promoted some other category, leave it alone.
		const existing = await sql`select id from categories where is_default limit 1`;
		if (existing.length > 0) {
			console.log(`→ default category already present (${existing[0].id}); nothing to do.`);
			return;
		}

		const inserted = await sql`
			insert into categories (name, slug, sort_order, description, source_lang, name_i18n, is_default)
			values (${DEFAULT_NAME}, ${DEFAULT_SLUG}, -1, null, 'zh-cn', '{}'::jsonb, true)
			on conflict do nothing
			returning id
		`;
		if (inserted.length === 0) {
			// Slug or name already taken by a user category: promote that one
			// instead of inventing a second fallback.
			const [promoted] = await sql`
				update categories set is_default = true
				where slug = ${DEFAULT_SLUG} or name = ${DEFAULT_NAME}
				returning id
			`;
			if (!promoted) {
				console.error('!! could not create or promote a default category');
				process.exitCode = 1;
				return;
			}
			console.log(`→ promoted existing category ${promoted.id} to default`);
			return;
		}
		console.log(`→ ensured default category ${inserted[0].id}`);
	} finally {
		await sql.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

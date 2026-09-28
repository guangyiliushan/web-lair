import postgres from 'postgres';
import { DEFAULT_PAGE_SLUGS, SEED_PAGES } from './_shared/pages';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('DATABASE_URL is required.');
	process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Seeds only the two protected defaults. Re-running never overwrites user
 * edits; editability is owned by the P5 admin/editor flow. `--dry-run` prints
 * what would be ensured (and what is already present) without writing.
 */
async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		const slugs = [...DEFAULT_PAGE_SLUGS];
		if (DRY_RUN) {
			const present = await sql`
				select slug, is_default
				from pages
				where slug in ${sql(slugs)}
				order by slug
			`;
			const state =
				present.map((row) => `${row.slug}(is_default=${row.is_default})`).join(', ') || 'none';
			console.log(`→ dry-run: would ensure ${slugs.join(', ')}; present: ${state}`);
			return;
		}

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
					${DEFAULT_PAGE_SLUGS.indexOf(seed.slug) + 1},
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
			where is_default and slug in ${sql(slugs)}
			order by slug
		`;
		if (rows.length !== SEED_PAGES.length) {
			const detail = await sql`
				select slug, is_default, status
				from pages
				where slug in ${sql(slugs)}
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

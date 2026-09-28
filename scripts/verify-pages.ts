import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('DATABASE_URL is required.');
	process.exit(1);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE_ROUTES = join(ROOT, 'src', 'routes', '(site)');
const EXPECTED_COLUMNS = [
	'id',
	'created_at',
	'updated_at',
	'slug',
	'title',
	'description',
	'icon',
	'external_url',
	'status',
	'sort_order',
	'is_default',
	'content',
	'content_format'
];
const EXPECTED_CHECKS = [
	'pages_status_check',
	'pages_external_url_check',
	'pages_title_object_check',
	'pages_description_object_check',
	'pages_content_object_check',
	'pages_content_format_check'
];
const RESERVED_SLUGS = new Set([
	'about',
	'about-site',
	'admin',
	'api',
	'demo',
	'files',
	'i',
	'maps',
	'photos',
	'robots.txt',
	'rss.xml',
	'sitemap.xml'
]);

function fail(message: string): never {
	throw new Error(message);
}

function routeSegments(): string[] {
	try {
		return readdirSync(SITE_ROUTES, { withFileTypes: true })
			.filter(
				(entry) => entry.isDirectory() && !entry.name.startsWith('(') && !entry.name.startsWith('[')
			)
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

function assertTitleHasLocale(title: unknown, slug: string): void {
	if (!title || typeof title !== 'object' || Array.isArray(title))
		fail(`pages.${slug}.title is not an object`);
	const values = Object.values(title as Record<string, unknown>).filter(
		(value) => typeof value === 'string' && value.trim().length > 0
	);
	if (values.length === 0) fail(`pages.${slug}.title has no locale`);
}

async function main(): Promise<void> {
	const sql = postgres(DB_URL!, { max: 1 });
	try {
		const columns = await sql`
			select attname as name
			from pg_attribute
			where attrelid = 'public.pages'::regclass
				and attnum > 0 and not attisdropped
			order by attnum
		`;
		const actualColumns = columns.map((row) => row.name);
		if (JSON.stringify(actualColumns) !== JSON.stringify(EXPECTED_COLUMNS)) {
			fail(`pages columns mismatch: ${actualColumns.join(', ')}`);
		}

		const checks = await sql`
			select conname as name
			from pg_constraint
			where conrelid = 'public.pages'::regclass and contype = 'c'
		`;
		const missingChecks = EXPECTED_CHECKS.filter(
			(expected) => !checks.some((row) => row.name === expected)
		);
		if (missingChecks.length > 0) fail(`missing page checks: ${missingChecks.join(', ')}`);

		const rows = await sql`
			select slug, title, description, icon, external_url, status,
				sort_order, is_default, content, content_format
			from pages
			order by sort_order, created_at
		`;
		const routeNames = routeSegments();
		const warnings: string[] = [];
		const defaults = new Set<string>();

		for (const row of rows) {
			const slug: string = row.slug;
			if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail(`invalid page slug: ${slug}`);
			if (
				(RESERVED_SLUGS.has(slug) && !['about', 'about-site'].includes(slug)) ||
				routeNames.includes(slug)
			) {
				fail(`reserved or code-route slug: ${slug}`);
			}
			if (row.external_url !== null && !/^https?:\/\//.test(row.external_url)) {
				fail(`invalid external_url for ${slug}`);
			}
			if (!['visible', 'hidden'].includes(row.status)) fail(`invalid status for ${slug}`);
			if (row.content_format !== 'markdown') fail(`invalid content_format for ${slug}`);
			assertTitleHasLocale(row.title, slug);
			if (row.is_default) defaults.add(slug);
			if (routeNames.includes(slug)) warnings.push(`code route shadows page row: /${slug}`);
		}

		for (const slug of ['about', 'about-site']) {
			if (!defaults.has(slug)) fail(`missing protected default page: ${slug}`);
		}

		if (warnings.length > 0) console.warn(`⚠ ${warnings.join('; ')}`);
		console.log(`✓ verified pages (${rows.length} rows, ${defaults.size} defaults)`);
	} finally {
		await sql.end();
	}
}

main().catch((error) => {
	console.error(`✗ ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { DEFAULT_PAGE_SLUGS } from './_shared/pages';
import { PAGE_RESERVED_SLUGS } from '../src/lib/utils/page-meta';

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
const DEFAULT_SLUG_SET: ReadonlySet<string> = new Set(DEFAULT_PAGE_SLUGS);
function fail(message: string): never {
	throw new Error(message);
}

function routeSegments(): string[] {
	let entries;
	try {
		entries = readdirSync(SITE_ROUTES, { withFileTypes: true });
	} catch (error) {
		fail(
			`cannot read site routes dir: ${SITE_ROUTES} (${error instanceof Error ? error.message : error})`
		);
	}
	return entries
		.filter(
			(entry) => entry.isDirectory() && !entry.name.startsWith('(') && !entry.name.startsWith('[')
		)
		.map((entry) => entry.name);
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
			if (PAGE_RESERVED_SLUGS.has(slug) && !DEFAULT_SLUG_SET.has(slug)) {
				fail(`reserved slug: ${slug}`);
			}
			if (row.external_url !== null && !/^https?:\/\//.test(row.external_url)) {
				fail(`invalid external_url for ${slug}`);
			}
			if (!['visible', 'hidden'].includes(row.status)) fail(`invalid status for ${slug}`);
			if (row.content_format !== 'markdown') fail(`invalid content_format for ${slug}`);
			assertTitleHasLocale(row.title, slug);
			if (row.is_default) defaults.add(slug);
			if (routeNames.includes(slug))
				warnings.push(
					`code route shadows page row: /${slug} (file wins; confirm the row is still wanted)`
				);
		}

		for (const slug of DEFAULT_PAGE_SLUGS) {
			if (!defaults.has(slug)) fail(`missing protected default page: ${slug}`);
		}
		if (defaults.size !== DEFAULT_PAGE_SLUGS.length)
			fail(
				`expected exactly 2 protected defaults, found ${defaults.size}: ${[...defaults].join(', ')}`
			);

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

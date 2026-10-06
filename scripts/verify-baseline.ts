// scripts/verify-baseline.ts
//
// Unified baseline gate (feat/schema-integration): asserts BOTH
//   (a) drizzle/0000_baseline.sql against the hard contract - table set, counts,
//       naming rules, junction composite PKs, batch constraint pins, predicate
//       pins, and the absence of retired tables; and
//   (b) the target database against the parsed baseline - table/column/index/
//       check/FK inventories, FK leading indexes, and the migration ledger
//       hash vs the baseline file (only when DATABASE_URL is present).
//
// Phase A (default) is read-only and degrades to file checks without a database.
// Phase B (--write-probes) additionally drives the constraint teeth from a
// single rolled-back transaction; run it on throwaway databases only, because
// it consumes identity numbers that transaction rollback does not restore.
//
// Usage:
//   pnpm db:verify-baseline                     (phase A; DATABASE_URL optional)
//   pnpm db:verify-baseline -- --write-probes   (phase A + probes, throwaway DB)

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL ?? null;
const WRITE_PROBES = process.argv.includes('--write-probes');
const unknownArgs = process.argv.slice(2).filter((a) => a !== '--write-probes');
if (unknownArgs.length > 0) {
	console.error(
		`✗ unknown arguments: ${unknownArgs.join(', ')} (only --write-probes is supported)`
	);
	process.exit(2);
}

const BASELINE_PATH = fileURLToPath(new URL('../drizzle/0000_baseline.sql', import.meta.url));
const JOURNAL_PATH = fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url));
const VISUALIZER_PATH = fileURLToPath(new URL('../.drizzle/visualizer.json', import.meta.url));

const EXPECTED = { tables: 48, indexes: 114, checks: 69, fks: 46, uuidv7: 36 };

const EXPECTED_TABLE_NAMES: string[] = [
	'account',
	'activities',
	'ai_agent_conversations',
	'ai_agent_memories',
	'ai_agent_messages',
	'ai_providers',
	'ai_usage',
	'categories',
	'comment_moderation_events',
	'comments',
	'drafts',
	'enrichment_captures',
	'file_references',
	'files',
	'glossary_terms',
	'invitation',
	'job_runs',
	'job_schedules',
	'links',
	'member',
	'moments',
	'notes',
	'options',
	'organization',
	'pages',
	'passkey',
	'photo_tags',
	'photos',
	'post_related_posts',
	'post_revisions',
	'post_tags',
	'posts',
	'projects',
	'quotes',
	'session',
	'slug_trackers',
	'subscriptions',
	'summaries',
	'tags',
	'thoughts',
	'topics',
	'translations',
	'two_factor',
	'user',
	'user_profiles',
	'verification',
	'webhook_deliveries',
	'webhooks'
];

const OFFICIAL_GENERATED_TABLES = new Set([
	'account',
	'invitation',
	'member',
	'organization',
	'passkey',
	'session',
	'two_factor',
	'user',
	'verification'
]);

/** Inline (tool-named) UNIQUE constraints allowed to skip the `_uniq` rule. */
const INLINE_UNIQUE_ALLOWED = new Set([
	'user_profiles_slug_unique',
	'user_email_unique',
	'session_token_unique',
	'organization_slug_unique'
]);

/** Tables that must NOT exist any more (renames / retirements across batches). */
const RETIRED_TABLE_NAMES = [
	'memos',
	'recent_items',
	'snippets',
	'serverless_logs',
	'serverless_storages',
	'poll_votes',
	'poll_vote_options',
	'meta_presets',
	'analytics',
	'search_documents',
	'enrichment_cache',
	'webhook_events',
	'draft_histories',
	'translation_entries',
	'insights',
	'api_keys',
	'device_codes',
	'admin_account',
	'owner_profiles'
];

/** Composite-PK constraint names for junction tables. */
const RETIRED_INDEX_NAMES = [
	'notes_nid_desc_idx',
	'notes_published_public_created_idx',
	'notes_topic_id_idx'
];

const JUNCTION_PKS: Record<string, string> = {
	photo_tags: 'photo_tags_photo_id_tag_id_pk',
	post_related_posts: 'post_related_posts_post_id_related_post_id_pk',
	post_tags: 'post_tags_post_id_tag_id_pk',
	file_references: 'file_references_file_id_ref_type_ref_id_pk'
};

/** Constraint names that must be present (batch pins; curated). */
const REQUIRED_CONSTRAINT_NAMES: string[] = [
	'notes_status_check',
	'notes_content_format_check',
	'notes_mood_check',
	'notes_weather_code_check',
	'notes_temperature_c_check',
	'notes_coordinates_check',
	'drafts_ref_type_check',
	'slug_trackers_type_check',
	'activities_event_check',
	'activities_ref_pair_check',
	'activities_ref_type_check',
	'files_status_check',
	'job_runs_status_check',
	'job_runs_trigger_check',
	'links_backlink_required_check',
	'links_banned_reason_check',
	'links_https_check',
	'links_lost_since_check',
	'links_ring_check',
	'links_status_check',
	'links_streak_check',
	'moments_type_check',
	'notes_lang_check',
	'notes_translation_origin_check',
	'pages_content_format_check',
	'pages_content_object_check',
	'pages_description_object_check',
	'pages_external_url_check',
	'pages_status_check',
	'pages_title_object_check',
	'photos_coords_check',
	'photos_description_shape_check',
	'photos_title_shape_check',
	'projects_external_id_check',
	'projects_provider_check',
	'projects_status_check',
	'subscriptions_lang_check',
	'subscriptions_status_check',
	'subscriptions_unsubscribed_at_check',
	'subscriptions_verified_at_check',
	'translations_origin_check',
	'translations_source_arc_check',
	'translations_status_check',
	'translations_target_arc_check',
	'translations_target_lang_check',
	'webhook_deliveries_status_check',
	'webhooks_payload_url_check'
];

/** Index predicate pins (checked against the baseline text; each must match). */
const PREDICATE_PINS: Array<[string, RegExp]> = [
	[
		'projects_extid_uniq',
		/CREATE UNIQUE INDEX "projects_extid_uniq" .*WHERE "projects"\."external_id" is not null/
	],
	[
		'projects_url_uniq',
		/CREATE UNIQUE INDEX "projects_url_uniq" .*WHERE "projects"\."external_id" is null/
	],
	[
		'job_runs_job_queued_uniq',
		/CREATE UNIQUE INDEX "job_runs_job_queued_uniq" .*WHERE "job_runs"\."status" = 'queued'/
	],
	['notes_lang_slug_uniq', /CREATE UNIQUE INDEX "notes_lang_slug_uniq" .*\("lang","slug"\)/],
	[
		'notes_translation_group_lang_uniq',
		/CREATE UNIQUE INDEX "notes_translation_group_lang_uniq" .*\("translation_group","lang"\)/
	],
	[
		'notes_nid_uniq',
		/CREATE UNIQUE INDEX "notes_nid_uniq" .*WHERE "notes"\."translated_from_note_id" is null/
	],
	[
		'notes_group_source_uniq',
		/CREATE UNIQUE INDEX "notes_group_source_uniq" .*WHERE "notes"\."translated_from_note_id" is null/
	],
	[
		'notes_translated_from_idx',
		/CREATE INDEX "notes_translated_from_idx" .*WHERE "notes"\."translated_from_note_id" is not null/
	],
	[
		'translations_draft_post_uniq',
		/CREATE UNIQUE INDEX "translations_draft_post_uniq" .*WHERE "translations"\."status" = 'draft' and "translations"\."source_post_id" is not null/
	],
	[
		'translations_draft_note_uniq',
		/CREATE UNIQUE INDEX "translations_draft_note_uniq" .*WHERE "translations"\."status" = 'draft' and "translations"\."source_note_id" is not null/
	],
	[
		'translations_source_post_idx',
		/CREATE INDEX "translations_source_post_idx" .*WHERE "translations"\."source_post_id" is not null/
	],
	[
		'translations_source_note_idx',
		/CREATE INDEX "translations_source_note_idx" .*WHERE "translations"\."source_note_id" is not null/
	],
	[
		'translations_target_post_idx',
		/CREATE INDEX "translations_target_post_idx" .*WHERE "translations"\."target_post_id" is not null/
	],
	[
		'translations_target_note_idx',
		/CREATE INDEX "translations_target_note_idx" .*WHERE "translations"\."target_note_id" is not null/
	],
	[
		'translations_reviewed_by_idx',
		/CREATE INDEX "translations_reviewed_by_idx" .*WHERE "translations"\."reviewed_by" is not null/
	],
	['links_review_idx', /CREATE INDEX "links_review_idx" .*WHERE "links"\."status" = 'pending'/],
	[
		'links_due_idx',
		/CREATE INDEX "links_due_idx" .*WHERE "links"\."status" in \('approved', 'outdated'\)/
	],
	[
		'links_reviewed_by_idx',
		/CREATE INDEX "links_reviewed_by_idx" .*WHERE "links"\."reviewed_by" is not null/
	],
	[
		'files_uploaded_by_idx',
		/CREATE INDEX "files_uploaded_by_idx" .*WHERE "files"\."uploaded_by" is not null/
	],
	[
		'notes_status_pin_published_idx',
		/CREATE INDEX "notes_status_pin_published_idx" .*\("status","pin_at" DESC NULLS LAST,"published_at" DESC NULLS LAST\)/
	],
	[
		'notes_topic_status_published_idx',
		/CREATE INDEX "notes_topic_status_published_idx" .*\("topic_id","status","pin_at" DESC NULLS LAST,"published_at" DESC NULLS LAST\)/
	],
	['drafts_topic_idx', /CREATE INDEX "drafts_topic_idx" .*WHERE "drafts"\."topic_id" is not null/],
	[
		'comments_note_thread_idx',
		/CREATE INDEX "comments_note_thread_idx" .*WHERE "comments"\."note_id" is not null/
	]
];

const COLUMN_TYPE_PINS: Array<[string, string, string]> = [
	['photos', 'latitude', 'numeric'],
	['photos', 'longitude', 'numeric'],
	['photos', 'f_number', 'numeric'],
	['photos', 'focal_length_mm', 'numeric'],
	['photos', 'exposure_time_s', 'numeric'],
	['photos', 'altitude_m', 'numeric'],
	['webhook_deliveries', 'response_code', 'integer'],
	['files', 'byte_size', 'bigint'],
	['enrichment_captures', 'byte_size', 'integer'],
	['notes', 'weather_code', 'smallint'],
	['notes', 'temperature_c', 'numeric'],
	['drafts', 'weather_code', 'smallint'],
	['drafts', 'temperature_c', 'numeric'],
	['posts', 'allow_comment', 'boolean']
];

/** Official generated-table exception for the FK leading-index rule. */
const FK_INDEX_EXCEPTION = 'invitation.invitation_inviter_id_user_id_fk';

function fail(message: string): never {
	throw new Error(message);
}

function expect(cond: boolean, message: string): void {
	if (!cond) fail(message);
}

function sameSets(actual: string[], expected: string[], label: string): void {
	const a = [...actual].sort();
	const e = [...expected].sort();
	expect(
		JSON.stringify(a) === JSON.stringify(e),
		`${label} mismatch\n  actual:   ${a.join(', ')}\n  expected: ${e.join(', ')}`
	);
}

// ---------------------------------------------------------------------------
// Parse the baseline file (single source of truth for shape).
// ---------------------------------------------------------------------------

const baseline = readFileSync(BASELINE_PATH);
const sha = createHash('sha256').update(baseline).digest('hex');
const text = baseline.toString('utf8');
const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as { entries: { tag: string }[] };

const tableBlocks = [...text.matchAll(/CREATE TABLE "([a-z_]+)" \((.*?)\n\);/gs)];
const tableColumns = new Map<string, string[]>();
const tableChecks = new Map<string, string[]>();
const tableHasPk = new Map<string, boolean>();
const tablePkIndex = new Map<string, string | null>();
const tableInlineUniques = new Map<string, string[]>();
const junctionPkSeen = new Set<string>();
for (const m of tableBlocks) {
	const name = m[1];
	const body = m[2];
	tableColumns.set(
		name,
		[...body.matchAll(/^\t"([a-z_0-9]+)" /gm)].map((x) => x[1])
	);
	const localChecks = [...body.matchAll(/CONSTRAINT "([a-z_0-9]+)" CHECK/g)].map((x) => x[1]);
	tableChecks.set(name, localChecks);
	const cpk = body.match(/CONSTRAINT "([a-z_0-9]+)" PRIMARY KEY/);
	if (cpk) junctionPkSeen.add(cpk[1]);
	const hasPk = body.includes('PRIMARY KEY');
	tableHasPk.set(name, hasPk);
	tablePkIndex.set(name, cpk ? cpk[1] : hasPk ? `${name}_pkey` : null);
	tableInlineUniques.set(
		name,
		[...body.matchAll(/CONSTRAINT "([a-z_0-9]+)" UNIQUE/g)].map((x) => x[1])
	);
}

const statements = text
	.split(';--> statement-breakpoint')
	.map((s) => s.trim())
	.filter((s) => s.length > 0);
const indexDefs = statements
	.filter((s) => /^CREATE (UNIQUE )?INDEX/.test(s))
	.map((s) => {
		const m = s.match(/^CREATE (UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"/);
		if (!m) fail(`unparseable index statement: ${s.slice(0, 80)}`);
		return { unique: Boolean(m[1]), name: m[2], table: m[3], full: s };
	});
const indexByName = new Map(indexDefs.map((d) => [d.name, d]));

const allChecks: string[] = [...tableChecks.values()].flat();
const fks = [
	...text.matchAll(
		/ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "([a-z_0-9]+)" FOREIGN KEY \("([a-z_0-9]+)"\) REFERENCES "public"\."([a-z_]+)"\("([a-z_0-9]+)"\) ON DELETE ([a-z ]+?) ON UPDATE/g
	)
].map((m) => ({
	table: m[1],
	name: m[2],
	column: m[3],
	refTable: m[4],
	refColumn: m[5],
	onDelete: m[6].trim()
}));

const uuidv7Count = (text.match(/DEFAULT uuidv7\(\)/g) ?? []).length;
const inlineUniques = [...text.matchAll(/CONSTRAINT "([a-z_0-9]+)" UNIQUE/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// File-level checks (no database required).
// ---------------------------------------------------------------------------

async function fileChecks(): Promise<void> {
	sameSets([...tableColumns.keys()], EXPECTED_TABLE_NAMES, 'table set');
	// .drizzle/visualizer.json is hand-maintained and has drifted twice (AI-1
	// batch, 09-28 integration) - pin its id set to the baseline table set.
	const visualizer = JSON.parse(readFileSync(VISUALIZER_PATH, 'utf8')) as Array<{ id: string }>;
	sameSets(
		visualizer.map((entry) => entry.id),
		EXPECTED_TABLE_NAMES,
		'.drizzle/visualizer.json ids vs baseline table set'
	);
	expect(tableBlocks.length === EXPECTED.tables, `table count = ${tableBlocks.length}`);
	expect(indexDefs.length === EXPECTED.indexes, `index count = ${indexDefs.length}`);
	expect(allChecks.length === EXPECTED.checks, `check count = ${allChecks.length}`);
	expect(fks.length === EXPECTED.fks, `fk count = ${fks.length}`);
	expect(uuidv7Count === EXPECTED.uuidv7, `uuidv7 default count = ${uuidv7Count}`);
	expect(!/CONCURRENTLY/i.test(text), 'baseline contains CONCURRENTLY');
	expect(!/gen_random_uuid/.test(text), 'baseline still uses gen_random_uuid()');

	for (const identifier of [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
		if (Buffer.byteLength(identifier, 'utf8') > 63)
			fail(`identifier exceeds 63 bytes: ${identifier}`);
	}
	for (const name of RETIRED_TABLE_NAMES) {
		expect(!text.includes(`CREATE TABLE "${name}"`), `retired table still present: ${name}`);
	}
	for (const name of RETIRED_INDEX_NAMES)
		expect(!indexByName.has(name), `retired index still present: ${name}`);

	// notes v0.3 reshape pins (plan §7.1): retired / added columns + NOT NULL.
	const notesBlock = tableBlocks.find((m) => m[1] === 'notes');
	expect(notesBlock !== undefined, 'notes block missing from baseline');
	const notesCols = tableColumns.get('notes') ?? [];
	for (const gone of [
		'text',
		'images',
		'password',
		'is_published',
		'public_at',
		'bookmark',
		'weather'
	])
		expect(!notesCols.includes(gone), `notes.${gone} should be retired`);
	for (const added of [
		'status',
		'tz',
		'weather_code',
		'temperature_c',
		'password_hash',
		'allow_comment',
		'pin_at',
		'published_at'
	])
		expect(notesCols.includes(added), `notes.${added} missing`);
	expect(/"title" text NOT NULL/.test(notesBlock![2]), 'notes.title must be NOT NULL');
	expect(/"slug" text NOT NULL/.test(notesBlock![2]), 'notes.slug must be NOT NULL');

	for (const def of indexDefs) {
		if (OFFICIAL_GENERATED_TABLES.has(def.table)) continue;
		if (!def.name.endsWith('_idx') && !def.name.endsWith('_uniq'))
			fail(`index name violates naming contract: ${def.name}`);
		if (def.name.endsWith('_uniq') && !def.unique)
			fail(`index named _uniq is not UNIQUE: ${def.name}`);
	}
	for (const name of allChecks)
		if (!name.endsWith('_check')) fail(`check name violates naming contract: ${name}`);
	for (const fk of fks)
		if (!fk.name.endsWith('_fk')) fail(`foreign-key name violates naming contract: ${fk.name}`);
	for (const name of inlineUniques) {
		expect(INLINE_UNIQUE_ALLOWED.has(name), `inline UNIQUE not registered: ${name}`);
	}

	for (const [table, expectedPk] of Object.entries(JUNCTION_PKS)) {
		expect(
			junctionPkSeen.has(expectedPk),
			`junction composite PK missing: ${table} -> ${expectedPk}`
		);
	}
	for (const name of tableColumns.keys()) {
		if (OFFICIAL_GENERATED_TABLES.has(name)) continue;
		expect(tableHasPk.get(name) === true, `hand-written table without PRIMARY KEY: ${name}`);
	}
	for (const name of REQUIRED_CONSTRAINT_NAMES) {
		expect(allChecks.includes(name), `missing required constraint: ${name}`);
	}
	for (const [name, pattern] of PREDICATE_PINS) {
		const def = indexByName.get(name);
		expect(def !== undefined, `pinned index missing: ${name}`);
		expect(pattern.test(def!.full), `pinned index lost its shape: ${name}`);
	}
	console.log(
		`✓ file checks: sha256=${sha.slice(0, 12)}… tables=${tableBlocks.length} indexes=${indexDefs.length} checks=${allChecks.length} fks=${fks.length} uuidv7=${uuidv7Count}`
	);
}

// ---------------------------------------------------------------------------
// Database checks (phase A) + constraint probes (phase B).
// ---------------------------------------------------------------------------

async function dbChecks(): Promise<void> {
	if (!DB_URL) {
		console.log('→ no DATABASE_URL: file checks only');
		return;
	}
	const sql = postgres(DB_URL, { max: 1 });
	try {
		const [ident] = await sql`select current_database() as db, current_user as usr`;
		console.log(
			`→ verify-baseline target: db=${ident.db} user=${ident.usr} phase=${WRITE_PROBES ? 'A+B' : 'A'} baseline=${sha.slice(0, 12)}…`
		);

		// A1 - table inventory (exact set).
		const tableRows =
			await sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
		sameSets(
			tableRows.map((r) => r.table_name),
			EXPECTED_TABLE_NAMES,
			'A1 table set'
		);

		// A2 - renames and retirements.
		const [reg] = await sql`select
			to_regclass('public.thoughts') as thoughts,
			to_regclass('public.moments') as moments`;
		expect(
			reg.thoughts !== null && reg.moments !== null,
			'A2 renamed tables missing (thoughts / moments)'
		);
		for (const name of RETIRED_TABLE_NAMES) {
			const [hit] = await sql`select to_regclass(${'public.' + name}) as rel`;
			expect(hit.rel === null, `A2 retired table still exists: ${name}`);
		}

		// A3 - column sets for hand-written tables.
		for (const [table, expected] of tableColumns) {
			if (OFFICIAL_GENERATED_TABLES.has(table)) continue;
			const rows =
				await sql`select attname from pg_attribute where attrelid = ${'public.' + table}::regclass and attnum > 0 and not attisdropped order by attnum`;
			sameSets(
				rows.map((r) => r.attname),
				expected,
				`A3 ${table} columns`
			);
		}

		// A3b - column type pins.
		for (const [table, column, dataType] of COLUMN_TYPE_PINS) {
			const [row] =
				await sql`select data_type from information_schema.columns where table_schema = 'public' and table_name = ${table} and column_name = ${column}`;
			expect(row !== undefined, `A3b ${table}.${column} missing`);
			expect(
				row.data_type === dataType,
				`A3b ${table}.${column} type = ${row.data_type}, expected ${dataType}`
			);
		}

		// A4 - index inventories (names + uniqueness per table).
		const dbIdx =
			await sql`select indexname, tablename, indexdef from pg_indexes where schemaname = 'public'`;
		const expectedByTable = new Map<string, string[]>();
		for (const def of indexDefs) {
			expectedByTable.set(def.table, [...(expectedByTable.get(def.table) ?? []), def.name]);
		}
		for (const table of tableColumns.keys()) {
			const pkIndex = tablePkIndex.get(table);
			const expected = [
				...(expectedByTable.get(table) ?? []),
				...(pkIndex ? [pkIndex] : []),
				...(tableInlineUniques.get(table) ?? [])
			];
			const actual = dbIdx.filter((r) => r.tablename === table).map((r) => r.indexname);
			sameSets(actual, expected, `A4 ${table} indexes`);
		}
		for (const def of indexDefs) {
			const row = dbIdx.find((r) => r.indexname === def.name);
			if (!row) continue;
			const dbUnique = row.indexdef.startsWith('CREATE UNIQUE INDEX');
			expect(dbUnique === def.unique, `A4 ${def.name} uniqueness mismatch (db unique=${dbUnique})`);
		}

		// A5 - CHECK constraint names per hand table.
		for (const [table, expected] of tableChecks) {
			if (OFFICIAL_GENERATED_TABLES.has(table)) continue;
			const rows =
				await sql`select conname from pg_constraint where conrelid = ${'public.' + table}::regclass and contype = 'c'`;
			sameSets(
				rows.map((r) => r.conname),
				expected,
				`A5 ${table} checks`
			);
		}

		// A6 - foreign keys (name / child / referenced / delete action).
		const actionMap: Record<string, string> = {
			a: 'no action',
			r: 'restrict',
			c: 'cascade',
			n: 'set null',
			d: 'set default'
		};
		const dbFks =
			await sql`select c.conname, c.conrelid::regclass::text as child, c.confrelid::regclass::text as ref, c.confdeltype
				from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace`;
		const dbFkTuples = dbFks
			.map(
				(r) =>
					`${r.conname}|${r.child.replace('public.', '').replaceAll('"', '')}|${r.ref.replace('public.', '').replaceAll('"', '')}|${actionMap[r.confdeltype] ?? r.confdeltype}`
			)
			.sort();
		const expectedFkTuples = fks
			.map((f) => `${f.name}|${f.table}|${f.refTable}|${f.onDelete}`)
			.sort();
		sameSets(dbFkTuples, expectedFkTuples, 'A6 foreign keys');

		// A7 - FK leading-index rule (single registered exception: official table).
		const gaps =
			await sql`select c.conrelid::regclass::text || '.' || c.conname as fk from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace and cardinality(c.conkey) = 1 and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`;
		sameSets(
			gaps.map((r) => r.fk),
			[FK_INDEX_EXCEPTION],
			'A7 FK leading-index gaps'
		);

		// A8 - migration ledger vs baseline file.
		const migs = await sql`select hash from drizzle.__drizzle_migrations order by created_at desc`;
		expect(
			migs.length === journal.entries.length,
			`A8 drizzle.__drizzle_migrations rows=${migs.length}, journal entries=${journal.entries.length}`
		);
		expect(
			migs[0]?.hash === sha,
			`A8 latest migration hash ${migs[0]?.hash} != sha256(baseline) ${sha}`
		);
		expect(
			journal.entries[0]?.tag === '0000_baseline',
			`A8 journal tag = ${journal.entries[0]?.tag}`
		);

		// Phase B - constraint teeth, one rolled-back transaction.
		if (!WRITE_PROBES) {
			console.log('→ write probes skipped (pass --write-probes on a throwaway database)');
			console.log('✓ verify-baseline phase A passed');
			return;
		}

		await sql.unsafe('begin');
		try {
			// Fixtures.
			const [src] =
				await sql`insert into notes (content_format, title, slug) values ('markdown', 'c1v-src', 'c1v-src') returning id, nid`;
			await sql`insert into notes (content_format, lang, title, slug, translated_from_note_id, nid) values ('markdown', 'ja', 'c1v-src-ja', 'c1v-src-ja', ${src.id}, ${src.nid})`;
			await sql`insert into translations (source_note_id, target_lang, title, origin) values (${src.id}, 'en', 't', 'ai')`;
			const [cat] =
				await sql`insert into categories (name, slug) values ('c1-verify', 'c1-verify') returning id`;
			const [post] =
				await sql`insert into posts (title, slug, category_id) values ('c1-verify', 'c1-verify-post', ${cat.id}) returning id`;
			await sql`insert into translations (source_post_id, target_lang, title, origin) values (${post.id}, 'en', 't', 'ai')`;
			await sql`insert into moments (type) select unnest(array['life', 'tech', 'media', 'other'])`;
			await sql`insert into notes (content_format, lang, title, slug) select 'markdown', x, 'c1v-lang-' || x, 'c1v-lang-' || x from unnest(array['en', 'zh-cn', 'ja']) as x`;
			await sql`insert into translations (source_note_id, target_lang, title, origin) values (${src.id}, 'ja', 't', 'human')`;
			await sql`insert into translations (source_note_id, target_lang, title, origin) values (${src.id}, 'zh-cn', 't', 'machine')`;
			const [tag] = await sql`insert into tags (slug, name) values ('c1v-tag', 'c1v') returning id`;
			const [file] =
				await sql`insert into files (object_key, content_hash, file_name, mime_type, byte_size) values ('c1v/1', 'c1vhash1', 'f.txt', 'text/plain', 1) returning id`;
			const [photo] =
				await sql`insert into photos (file_id, slug, latitude, longitude) values (${file.id}, 'c1v-photo', 12.345678, 123.456789) returning id`;
			await sql`insert into photo_tags (photo_id, tag_id) values (${photo.id}, ${tag.id})`;
			await sql`insert into projects (name, project_url, provider, external_id) values ('c1v-p', 'https://p.example', 'github', 'c1v/g')`;
			await sql`insert into projects (name, project_url, provider) values ('c1v-s', 'https://s.example', 'site')`;
			await sql`insert into links (name, url, host, backlink_url) values ('c1v-ok-link', 'https://ok.example/', 'ok.example', 'https://ok.example/link')`;
			// Positive control (review round 4): a full 10-element ring is
			// legal - proves links_ring_check is not over-strict. NOTE:
			// postgres.js infers the parameter type from the ::jsonb cast and
			// would JSON-encode a plain string parameter into a jsonb STRING
			// (scalar, failing the check) - sql.json() sends proper json.
			await sql`insert into links (name, url, host, backlink_url, recent_checks) values ('c1v-ring-full', 'https://ring.example/', 'ring.example', 'https://ring.example/link', ${sql.json(Array.from({ length: 10 }, () => ({ at: '2026-01-01T00:00:00.000Z', kind: 'reachability', ok: true })))}::jsonb)`;
			await sql`select set_config('c1.src', ${src.id}, true)`;
			await sql`select set_config('c1.post', ${post.id}, true)`;
			await sql`select set_config('c1.tag', ${tag.id}, true)`;
			await sql`select set_config('c1.file', ${file.id}, true)`;
			await sql`select set_config('c1.photo', ${photo.id}, true)`;

			// Negatives: each must fail with the exact constraint name.
			await sql.unsafe(`
do $$
declare
	c text;
	m text;
	s uuid := current_setting('c1.src')::uuid;
	p uuid := current_setting('c1.post')::uuid;
	tg uuid := current_setting('c1.tag')::uuid;
	fl uuid := current_setting('c1.file')::uuid;
	ph uuid := current_setting('c1.photo')::uuid;
	g uuid;
	s2 uuid;
	src_nid int;
begin
	begin
		insert into moments (type) values ('x');
		raise exception 'FAIL moments_type_check accepted x';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'moments_type_check' then raise exception 'FAIL moments.type: wrong constraint %', c; end if;
	end;

	begin
		insert into moments (content) values ('x');
		raise exception 'FAIL moments accepted a row without type';
	exception when not_null_violation then
		null;
	end;

	begin
		insert into notes (content_format, lang, title, slug) values ('markdown', 'xx', 'c1v-xx', 'c1v-xx');
		raise exception 'FAIL notes_lang_check accepted xx';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_lang_check' then raise exception 'FAIL notes.lang: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, translation_origin, title, slug) values ('markdown', 'x', 'c1v-origin', 'c1v-origin');
		raise exception 'FAIL notes_translation_origin_check accepted x';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_translation_origin_check' then raise exception 'FAIL notes.origin: wrong constraint %', c; end if;
	end;

	begin
		insert into translations (target_lang, title, origin) values ('en', 't', 'ai');
		raise exception 'FAIL translations_source_arc_check accepted zero sources';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'translations_source_arc_check' then raise exception 'FAIL source arc 0: wrong constraint %', c; end if;
	end;

	begin
		insert into translations (source_post_id, source_note_id, target_lang, title, origin)
			values (p, s, 'en', 't', 'ai');
		raise exception 'FAIL translations_source_arc_check accepted two sources';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'translations_source_arc_check' then raise exception 'FAIL source arc 2: wrong constraint %', c; end if;
	end;

	begin
		insert into translations (source_note_id, target_post_id, target_note_id, target_lang, title, origin)
			values (s, p, s, 'en', 't', 'ai');
		raise exception 'FAIL translations_target_arc_check accepted two targets';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'translations_target_arc_check' then raise exception 'FAIL target arc 2: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, title, slug) values ('markdown', 'ja', 'c1v-dup', 'c1-dup');
		insert into notes (content_format, lang, title, slug) values ('markdown', 'ja', 'c1v-dup', 'c1-dup');
		raise exception 'FAIL notes_lang_slug_uniq accepted a duplicate (lang, slug)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_lang_slug_uniq' then raise exception 'FAIL (lang,slug): wrong constraint %', c; end if;
	end;

	begin
		g := 'bbbb2222-0000-0000-0000-000000000001';
		insert into notes (content_format, lang, translation_group, title, slug) values ('markdown', 'zh-cn', g, 'c1v-g2-zh', 'c1v-g2-zh');
		insert into notes (content_format, lang, translation_group, translated_from_note_id, title, slug)
			values ('markdown', 'ja', g, s, 'c1v-g2-ja-a', 'c1v-g2-ja-a');
		insert into notes (content_format, lang, translation_group, translated_from_note_id, title, slug)
			values ('markdown', 'ja', g, s, 'c1v-g2-ja-b', 'c1v-g2-ja-b');
		raise exception 'FAIL notes_translation_group_lang_uniq accepted a duplicate (group, lang)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_translation_group_lang_uniq' then raise exception 'FAIL (group,lang): wrong constraint %', c; end if;
	end;

	begin
		g := 'bbbb2222-0000-0000-0000-000000000002';
		insert into notes (content_format, lang, translation_group, title, slug) values ('markdown', 'en', g, 'c1v-g3-en', 'c1v-g3-en');
		insert into notes (content_format, lang, translation_group, title, slug) values ('markdown', 'ja', g, 'c1v-g3-ja', 'c1v-g3-ja');
		raise exception 'FAIL notes_group_source_uniq accepted a second source';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_group_source_uniq' then raise exception 'FAIL second source: wrong constraint %', c; end if;
	end;

	begin
		select nid into src_nid from notes where id = s;
		insert into notes (content_format, nid, title, slug) values ('markdown', src_nid, 'c1v-nid-dup', 'c1v-nid-dup');
		raise exception 'FAIL notes_nid_uniq accepted a duplicate source nid';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_nid_uniq' then raise exception 'FAIL nid: wrong constraint %', c; end if;
	end;

	begin
		insert into translations (source_note_id, target_lang, title, origin) values (s, 'en', 't2', 'ai');
		raise exception 'FAIL translations_draft_note_uniq accepted a second draft';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'translations_draft_note_uniq' then raise exception 'FAIL note draft: wrong constraint %', c; end if;
	end;

	begin
		insert into translations (source_post_id, target_lang, title, origin) values (p, 'en', 't2', 'ai');
		raise exception 'FAIL translations_draft_post_uniq accepted a second draft';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'translations_draft_post_uniq' then raise exception 'FAIL post draft: wrong constraint %', c; end if;
	end;

	-- Junction PK (P0 repair): duplicate (photo_id, tag_id) must be rejected.
	begin
		insert into photo_tags (photo_id, tag_id) values (ph, tg);
		raise exception 'FAIL photo_tags accepted a duplicate (photo_id, tag_id)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'photo_tags_photo_id_tag_id_pk' then raise exception 'FAIL photo_tags pk: wrong constraint %', c; end if;
	end;

	-- Projects uniqueness (P0 repair).
	begin
		insert into projects (name, project_url, provider, external_id) values ('c1v-p2', 'https://p2.example', 'github', 'c1v/g');
		raise exception 'FAIL projects_extid_uniq accepted a duplicate (provider, external_id)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'projects_extid_uniq' then raise exception 'FAIL projects extid: wrong constraint %', c; end if;
	end;

	begin
		insert into projects (name, project_url, provider) values ('c1v-s2', 'https://s.example', 'site');
		raise exception 'FAIL projects_url_uniq accepted a duplicate (provider, project_url)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'projects_url_uniq' then raise exception 'FAIL projects url: wrong constraint %', c; end if;
	end;

	begin
		insert into projects (name, project_url, provider) values ('c1v-x', 'https://x.example', 'github');
		raise exception 'FAIL projects_external_id_check accepted github without external_id';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'projects_external_id_check' then raise exception 'FAIL projects extid check: wrong constraint %', c; end if;
	end;

	-- Subscriptions state machine (P1 repair): pending must not carry verified_at;
	-- unsubscribed must carry unsubscribed_at; verified history is retained.
	begin
		insert into subscriptions (email, token, status, verified_at) values ('c1v-1@example.com', 'c1v-tok-1', 'pending', now());
		raise exception 'FAIL subscriptions_verified_at_check accepted pending with verified_at';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'subscriptions_verified_at_check' then raise exception 'FAIL subscriptions verified: wrong constraint %', c; end if;
	end;

	begin
		insert into subscriptions (email, token, status, verified_at) values ('c1v-2@example.com', 'c1v-tok-2', 'unsubscribed', now());
		raise exception 'FAIL subscriptions_unsubscribed_at_check accepted unsubscribed without unsubscribed_at';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'subscriptions_unsubscribed_at_check' then raise exception 'FAIL subscriptions unsub: wrong constraint %', c; end if;
	end;

	insert into subscriptions (email, token, status, verified_at, unsubscribed_at)
		values ('c1v-3@example.com', 'c1v-tok-3', 'unsubscribed', now(), now());

	-- Enrichment captures: (provider, source_url) key is unique.
	begin
		insert into enrichment_captures (provider, source_url, object_key, byte_size, width, height)
			values ('c1v', 'https://e.example/i.png', 'c1v/obj1', 10, 1, 1);
		insert into enrichment_captures (provider, source_url, object_key, byte_size, width, height)
			values ('c1v', 'https://e.example/i.png', 'c1v/obj2', 10, 1, 1);
		raise exception 'FAIL enrichment_captures_source_uniq accepted a duplicate (provider, source_url)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'enrichment_captures_source_uniq' then raise exception 'FAIL captures source: wrong constraint %', c; end if;
	end;

	-- Photos coordinate range.
	begin
		insert into photos (file_id, slug, latitude) values (fl, 'c1v-bad', 91);
		raise exception 'FAIL photos_coords_check accepted latitude=91';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'photos_coords_check' then raise exception 'FAIL photos coords: wrong constraint %', c; end if;
	end;

	-- Links evidence ring: non-array jsonb must be rejected by the CHECK.
	begin
		insert into links (name, url, host, backlink_url, recent_checks) values ('c1v-link', 'https://l.example/', 'l.example', 'https://l.example/link', '{"o":1}'::jsonb);
		raise exception 'FAIL links_ring_check accepted an object ring';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_ring_check' then raise exception 'FAIL links ring: wrong constraint %', c; end if;
	end;

	-- L1 acceptance teeth (links plan §2.2; 2026-10-06): the remaining seven
	-- negatives - banned without reason, lost_since both directions, plain
	-- http, approved without backlink, an 11-element ring, duplicate url.
	begin
		insert into links (name, url, host, backlink_url, status) values ('c1v-l1', 'https://l1.example/', 'l1.example', 'https://l1.example/', 'banned');
		raise exception 'FAIL links_banned_reason_check accepted banned without a reason';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_banned_reason_check' then raise exception 'FAIL links banned: wrong constraint %', c; end if;
	end;

	begin
		insert into links (name, url, host, backlink_url, status, lost_since) values ('c1v-l2', 'https://l2.example/', 'l2.example', 'https://l2.example/', 'approved', now());
		raise exception 'FAIL links_lost_since_check accepted approved with lost_since';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_lost_since_check' then raise exception 'FAIL links lost approved: wrong constraint %', c; end if;
	end;

	begin
		insert into links (name, url, host, backlink_url, status) values ('c1v-l3', 'https://l3.example/', 'l3.example', 'https://l3.example/', 'outdated');
		raise exception 'FAIL links_lost_since_check accepted outdated without lost_since';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_lost_since_check' then raise exception 'FAIL links lost outdated: wrong constraint %', c; end if;
	end;

	begin
		insert into links (name, url, host, backlink_url) values ('c1v-l4', 'http://l4.example/', 'l4.example', 'https://l4.example/');
		raise exception 'FAIL links_https_check accepted a plain-http url';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_https_check' then raise exception 'FAIL links https: wrong constraint %', c; end if;
	end;

	begin
		insert into links (name, url, host, status) values ('c1v-l5', 'https://l5.example/', 'l5.example', 'approved');
		raise exception 'FAIL links_backlink_required_check accepted approved without backlink_url';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_backlink_required_check' then raise exception 'FAIL links backlink: wrong constraint %', c; end if;
	end;

	begin
		insert into links (name, url, host, backlink_url, recent_checks) values ('c1v-l6', 'https://l6.example/', 'l6.example', 'https://l6.example/', '[1,2,3,4,5,6,7,8,9,10,11]'::jsonb);
		raise exception 'FAIL links_ring_check accepted an 11-element ring';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_ring_check' then raise exception 'FAIL links ring 11: wrong constraint %', c; end if;
	end;

	begin
		insert into links (name, url, host, backlink_url) values ('c1v-l7', 'https://ok.example/', 'ok.example', 'https://ok.example/');
		raise exception 'FAIL links_url_uniq accepted a duplicate url';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'links_url_uniq' then raise exception 'FAIL links url uniq: wrong constraint %', c; end if;
	end;

	-- notes v0.3 reshape teeth (plan §7.5)
	begin
		insert into notes (content_format, lang, title, slug, status)
			values ('markdown', 'en', 'c1v-st', 'c1v-st', 'x');
		raise exception 'FAIL notes_status_check accepted x';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_status_check' then raise exception 'FAIL status: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, title, slug) values ('x', 'en', 'c1v-cf', 'c1v-cf');
		raise exception 'FAIL notes_content_format_check accepted x';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_content_format_check' then raise exception 'FAIL content_format: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, title, slug, mood) values ('markdown', 'en', 'c1v-md', 'c1v-md', 'x');
		raise exception 'FAIL notes_mood_check accepted x';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_mood_check' then raise exception 'FAIL mood: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, title, slug, weather_code) values ('markdown', 'en', 'c1v-wc', 'c1v-wc', 100);
		raise exception 'FAIL notes_weather_code_check accepted 100';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_weather_code_check' then raise exception 'FAIL weather_code: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, title, slug, temperature_c) values ('markdown', 'en', 'c1v-tc', 'c1v-tc', 100);
		raise exception 'FAIL notes_temperature_c_check accepted 100';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_temperature_c_check' then raise exception 'FAIL temperature: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, title, slug, coordinates)
			values ('markdown', 'en', 'c1v-co', 'c1v-co', '{"latitude": 91, "longitude": 0}'::jsonb);
		raise exception 'FAIL notes_coordinates_check accepted latitude 91';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_coordinates_check' then raise exception 'FAIL coords range: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, title, slug, coordinates)
			values ('markdown', 'en', 'c1v-co2', 'c1v-co2', '"oops"'::jsonb);
		raise exception 'FAIL notes_coordinates_check accepted a non-object';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_coordinates_check' then raise exception 'FAIL coords shape: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, lang, slug) values ('markdown', 'en', 'c1v-nt');
		raise exception 'FAIL notes accepted a row without title';
	exception when not_null_violation then
		get stacked diagnostics c = constraint_name;
		get stacked diagnostics m = message_text;
		if (c <> '' and c not like '%not_null') or m not like '%title%' then
			raise exception 'FAIL title not-null: constraint=%, message=%', c, m;
		end if;
	end;

	begin
		insert into drafts (ref_type, title) values ('x', 'c1v');
		raise exception 'FAIL drafts_ref_type_check accepted x';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'drafts_ref_type_check' then raise exception 'FAIL drafts ref_type: wrong constraint %', c; end if;
	end;

	begin
		insert into slug_trackers (slug, type, target_id)
			values ('c1v-old', 'x', '00000000-0000-0000-0000-000000000000');
		raise exception 'FAIL slug_trackers_type_check accepted x';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'slug_trackers_type_check' then raise exception 'FAIL tracker type: wrong constraint %', c; end if;
	end;

	-- Source-deletion trap (ledger §17): with >=2 translated rows in the group
	-- the DB refuses deleting the source (SET NULL would collide with
	-- notes_group_source_uniq). With exactly one translated row the delete
	-- currently succeeds and that row silently becomes the group source -
	-- registered behaviour, application-level group flow handles it first.
	begin
		g := 'bbbb2222-0000-0000-0000-000000000003';
		insert into notes (content_format, lang, translation_group, title, slug) values ('markdown', 'en', g, 'c1v-del-en', 'c1v-del-en') returning id into s2;
		insert into notes (content_format, lang, translation_group, translated_from_note_id, title, slug)
			values ('markdown', 'ja', g, s2, 'c1v-del-ja', 'c1v-del-ja'), ('markdown', 'zh-cn', g, s2, 'c1v-del-zh', 'c1v-del-zh');
		delete from notes where id = s2;
		raise exception 'FAIL deleting a source with translations was allowed';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_group_source_uniq' then raise exception 'FAIL delete-source: wrong constraint %', c; end if;
	end;
end $$;`);

			await sql.unsafe('rollback');
			console.log('✓ write probes passed (all constraint teeth fired, transaction rolled back)');
		} catch (error) {
			await sql.unsafe('rollback').catch(() => undefined);
			throw error;
		}
		console.log('✓ verify-baseline phase A+B passed');
	} finally {
		await sql.end({ timeout: 5 });
	}
}

async function main(): Promise<void> {
	await fileChecks();
	await dbChecks();
	console.log(
		`✓ verified baseline: sha256=${sha} tables=${EXPECTED.tables} indexes=${EXPECTED.indexes} checks=${EXPECTED.checks} fks=${EXPECTED.fks} uuidv7=${EXPECTED.uuidv7}`
	);
}

main().catch((error) => {
	console.error('✗ verify-baseline failed:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
});

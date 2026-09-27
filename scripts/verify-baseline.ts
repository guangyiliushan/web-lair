// scripts/verify-baseline.ts
//
// C1 baseline gate (micro-content line): asserts the target database matches
// drizzle/0000_baseline.sql - table/column/index/constraint inventories, the
// renamed tables, the partial predicates that carry this batch's invariants,
// FK leading indexes, and the migration ledger hash vs the baseline file.
//
// Phase A (default) is read-only: safe against the live database.
// Phase B (--write-probes) additionally drives the constraint teeth from a
// single rolled-back transaction; run it on throwaway databases only, because
// it consumes identity numbers that transaction rollback does not restore.
//
// Usage:
//   pnpm db:verify-baseline                     (phase A)
//   pnpm db:verify-baseline -- --write-probes   (phase A + probes, throwaway DB)
// Env: DATABASE_URL

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
	console.error('✗ DATABASE_URL is required.');
	process.exit(1);
}
const WRITE_PROBES = process.argv.includes('--write-probes');

const baselinePath = fileURLToPath(new URL('../drizzle/0000_baseline.sql', import.meta.url));
const journalPath = fileURLToPath(new URL('../drizzle/meta/_journal.json', import.meta.url));

const EXPECTED_TABLES = 52;

const EXPECTED_COLUMNS: Record<string, string[]> = {
	quotes: ['id', 'created_at', 'updated_at', 'content', 'source', 'author'],
	thoughts: ['id', 'created_at', 'updated_at', 'content'],
	moments: [
		'id',
		'created_at',
		'content',
		'type',
		'metadata',
		'ref_type',
		'ref_id',
		'updated_at',
		'up',
		'down'
	],
	translations: [
		'id',
		'created_at',
		'updated_at',
		'source_post_id',
		'source_note_id',
		'target_lang',
		'title',
		'content',
		'summary',
		'content_format',
		'origin',
		'model',
		'source_hash',
		'status',
		'score',
		'reviewed_by',
		'reviewed_at',
		'target_post_id',
		'target_note_id',
		'error'
	]
};

const NOTES_REQUIRED_COLUMNS = [
	'lang',
	'translation_group',
	'translated_from_note_id',
	'translation_origin'
];

const NOTES_LEGACY_COLUMN_MEANING = ['text']; // kept on purpose until notes v0.2

const EXPECTED_INDEXES: Record<string, string[]> = {
	thoughts: ['thoughts_pkey', 'thoughts_created_at_idx'],
	quotes: ['quotes_pkey', 'quotes_created_at_idx'],
	moments: [
		'moments_pkey',
		'moments_ref_idx',
		'moments_created_at_idx',
		'moments_type_created_idx'
	],
	notes: [
		'notes_pkey',
		'notes_nid_uniq',
		'notes_lang_slug_uniq',
		'notes_translation_group_lang_uniq',
		'notes_group_source_uniq',
		'notes_translated_from_idx',
		'notes_nid_desc_idx',
		'notes_updated_at_idx',
		'notes_created_at_idx',
		'notes_topic_id_idx',
		'notes_published_public_created_idx'
	],
	translations: [
		'translations_pkey',
		'translations_draft_post_uniq',
		'translations_draft_note_uniq',
		'translations_source_post_idx',
		'translations_source_note_idx',
		'translations_target_post_idx',
		'translations_target_note_idx',
		'translations_reviewed_by_idx'
	]
};

/** Partial predicates this batch relies on; each entry = [index, mustMatch, mustNotMatch?]. */
const PREDICATE_PINS: Array<[string, RegExp, RegExp?]> = [
	['quotes_created_at_idx', /^CREATE INDEX/, /WHERE/],
	['thoughts_created_at_idx', /^CREATE INDEX/, /WHERE/],
	['moments_ref_idx', /^CREATE INDEX/, /WHERE/],
	['moments_created_at_idx', /^CREATE INDEX/, /WHERE/],
	['moments_type_created_idx', /^CREATE INDEX/, /WHERE/],
	['notes_nid_uniq', /WHERE \(translated_from_note_id IS NULL\)/],
	['notes_lang_slug_uniq', /^CREATE UNIQUE INDEX.*\(lang, slug\)/, /WHERE/],
	[
		'notes_translation_group_lang_uniq',
		/^CREATE UNIQUE INDEX.*\(translation_group, lang\)/,
		/WHERE/
	],
	['notes_group_source_uniq', /WHERE \(translated_from_note_id IS NULL\)/],
	['notes_translated_from_idx', /WHERE \(translated_from_note_id IS NOT NULL\)/],
	[
		'translations_draft_post_uniq',
		/WHERE \(\(status = 'draft'::text\) AND \(source_post_id IS NOT NULL\)\)/
	],
	[
		'translations_draft_note_uniq',
		/WHERE \(\(status = 'draft'::text\) AND \(source_note_id IS NOT NULL\)\)/
	],
	['translations_source_post_idx', /WHERE \(source_post_id IS NOT NULL\)/],
	['translations_source_note_idx', /WHERE \(source_note_id IS NOT NULL\)/],
	['translations_target_post_idx', /WHERE \(target_post_id IS NOT NULL\)/],
	['translations_target_note_idx', /WHERE \(target_note_id IS NOT NULL\)/],
	['translations_reviewed_by_idx', /WHERE \(reviewed_by IS NOT NULL\)/]
];

const EXPECTED_CHECKS: Record<string, string[]> = {
	moments: ['moments_type_check'],
	notes: ['notes_lang_check', 'notes_translation_origin_check'],
	translations: [
		'translations_origin_check',
		'translations_source_arc_check',
		'translations_status_check',
		'translations_target_arc_check',
		'translations_target_lang_check'
	]
};

/** Expected FKs on this batch: [constraint name, confdeltype, referenced table]. */
const EXPECTED_FKS: Array<[string, string, string]> = [
	['notes_translated_from_note_id_notes_id_fk', 'n', 'notes'],
	['translations_source_note_id_notes_id_fk', 'c', 'notes'],
	['translations_source_post_id_posts_id_fk', 'c', 'posts'],
	['translations_target_note_id_notes_id_fk', 'n', 'notes'],
	['translations_target_post_id_posts_id_fk', 'n', 'posts']
];

/** Official generated-table exception for the FK leading-index rule. */
const FK_INDEX_EXCEPTION = 'invitation.invitation_inviter_id_user_id_fk';

function expect(cond: boolean, message: string): void {
	if (!cond) throw new Error(message);
}

function sameSets(actual: string[], expected: string[], label: string): void {
	const a = [...actual].sort();
	const e = [...expected].sort();
	expect(
		JSON.stringify(a) === JSON.stringify(e),
		`${label} mismatch\n  actual:   ${a.join(', ')}\n  expected: ${e.join(', ')}`
	);
}

async function main() {
	const baseline = readFileSync(baselinePath);
	const sha = createHash('sha256').update(baseline).digest('hex');
	const baselineText = baseline.toString('utf8');
	const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };

	const sql = postgres(DB_URL!, { max: 1 });
	try {
		const [ident] = await sql`select current_database() as db, current_user as usr`;
		console.log(
			`→ verify-baseline target: db=${ident.db} user=${ident.usr} ` +
				`phase=${WRITE_PROBES ? 'A+B' : 'A'} baseline=${sha.slice(0, 12)}…`
		);

		// A1 — table inventory.
		const [{ count: tableCount }] =
			await sql`select count(*)::int as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`;
		expect(
			tableCount === EXPECTED_TABLES,
			`A1 table count = ${tableCount}, expected ${EXPECTED_TABLES}`
		);

		// A2 — renames.
		const [reg] = await sql`select
			to_regclass('public.memos') as memos,
			to_regclass('public.recent_items') as recent,
			to_regclass('public.thoughts') as thoughts,
			to_regclass('public.moments') as moments`;
		expect(
			reg.memos === null && reg.recent === null,
			'A2 old table names still exist (memos / recent_items)'
		);
		expect(
			reg.thoughts !== null && reg.moments !== null,
			'A2 renamed tables missing (thoughts / moments)'
		);

		// A3 — column sets.
		for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
			const rows =
				await sql`select attname from pg_attribute where attrelid = ${'public.' + table}::regclass and attnum > 0 and not attisdropped order by attnum`;
			sameSets(
				rows.map((r) => r.attname),
				expected,
				`A3 ${table} columns`
			);
		}
		const noteCols =
			await sql`select attname from pg_attribute where attrelid = 'public.notes'::regclass and attnum > 0 and not attisdropped`;
		const noteColNames = noteCols.map((r) => r.attname);
		for (const col of NOTES_REQUIRED_COLUMNS) {
			expect(noteColNames.includes(col), `A3 notes.${col} missing (multilingual contract)`);
		}
		for (const col of NOTES_LEGACY_COLUMN_MEANING) {
			expect(
				noteColNames.includes(col),
				`A3 notes.${col} unexpectedly dropped (notes v0.2 owns that)`
			);
		}
		for (const dead of ['comments_index', 'allow_comment']) {
			const hit =
				await sql`select 1 from pg_attribute where attrelid = 'public.moments'::regclass and attname = ${dead} and attnum > 0 and not attisdropped`;
			expect(hit.length === 0, `A3 moments.${dead} should be dropped (ledger §9.5)`);
		}
		const [typeCol] =
			await sql`select column_default from information_schema.columns where table_name = 'moments' and column_name = 'type'`;
		expect(
			typeCol.column_default === null,
			`A3 moments.type has a default (${typeCol.column_default})`
		);

		// A4 — index inventories + predicate pins.
		for (const [table, expected] of Object.entries(EXPECTED_INDEXES)) {
			const rows = await sql`select indexname from pg_indexes where tablename = ${table}`;
			sameSets(
				rows.map((r) => r.indexname),
				expected,
				`A4 ${table} indexes`
			);
		}
		for (const [name, mustMatch, mustNotMatch] of PREDICATE_PINS) {
			const [row] = await sql`select indexdef from pg_indexes where indexname = ${name}`;
			expect(row !== undefined, `A4 index ${name} missing`);
			expect(mustMatch.test(row.indexdef), `A4 ${name} definition lost its pin: ${row.indexdef}`);
			if (mustNotMatch) {
				expect(
					!mustNotMatch.test(row.indexdef),
					`A4 ${name} unexpectedly has a predicate: ${row.indexdef}`
				);
			}
		}

		// A5 — CHECK constraint names.
		for (const [table, expected] of Object.entries(EXPECTED_CHECKS)) {
			const rows =
				await sql`select conname from pg_constraint where conrelid = ${'public.' + table}::regclass and contype = 'c'`;
			sameSets(
				rows.map((r) => r.conname),
				expected,
				`A5 ${table} checks`
			);
		}

		// A6 — expected foreign keys (name / delete action / referenced table).
		const fks =
			await sql`select conname, confdeltype, confrelid::regclass::text as ref from pg_constraint where contype = 'f' and conrelid = 'public.translations'::regclass or contype = 'f' and conrelid = 'public.notes'::regclass`;
		for (const [name, deltype, ref] of EXPECTED_FKS) {
			const hit = fks.find((r) => r.conname === name);
			expect(hit !== undefined, `A6 foreign key ${name} missing`);
			expect(
				hit.confdeltype === deltype && hit.ref === ref,
				`A6 ${name}: expected delete=${deltype} ref=${ref}, got delete=${hit.confdeltype} ref=${hit.ref}`
			);
		}

		// A7 — FK leading-index rule (single exception: official generated table).
		const gaps =
			await sql`select c.conrelid::regclass::text || '.' || c.conname as fk from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace and cardinality(c.conkey) = 1 and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`;
		const gapNames = gaps.map((r) => r.fk).sort();
		sameSets(gapNames, [FK_INDEX_EXCEPTION], 'A7 FK leading-index gaps');

		// A8 — migration ledger vs baseline file.
		const migs = await sql`select hash from drizzle.__drizzle_migrations order by created_at desc`;
		expect(
			migs.length === journal.entries.length,
			`A8 drizzle.__drizzle_migrations rows=${migs.length}, journal entries=${journal.entries.length}`
		);
		expect(
			migs[0]?.hash === sha,
			`A8 latest migration hash ${migs[0]?.hash} != sha256(baseline) ${sha}`
		);
		expect(!/CONCURRENTLY/.test(baselineText), 'A8 baseline contains CONCURRENTLY');
		expect(
			baselineText.includes('CREATE TABLE "thoughts"') &&
				baselineText.includes('CREATE TABLE "moments"'),
			'A8 baseline missing the renamed tables'
		);

		// Phase B — constraint teeth, one rolled-back transaction.
		if (!WRITE_PROBES) {
			console.log('→ write probes skipped (pass --write-probes on a throwaway database)');
			console.log('✓ verify-baseline phase A passed');
			return;
		}

		await sql.unsafe('begin');
		try {
			// Positives.
			const [src] =
				await sql`insert into notes (content_format) values ('markdown') returning id, nid`;
			await sql`insert into notes (content_format, lang, translated_from_note_id, nid) values ('markdown', 'ja', ${src.id}, ${src.nid})`;
			await sql`insert into translations (source_note_id, target_lang, title, origin) values (${src.id}, 'en', 't', 'ai')`;
			const [cat] =
				await sql`insert into categories (name, slug) values ('c1-verify', 'c1-verify') returning id`;
			const [post] =
				await sql`insert into posts (title, slug, category_id) values ('c1-verify', 'c1-verify-post', ${cat.id}) returning id`;
			await sql`insert into translations (source_post_id, target_lang, title, origin) values (${post.id}, 'en', 't', 'ai')`;
			await sql`insert into moments (type) select unnest(array['life', 'tech', 'media', 'other'])`;
			await sql`insert into notes (content_format, lang) select 'markdown', x from unnest(array['en', 'zh-cn', 'ja']) as x`;
			await sql`insert into translations (source_note_id, target_lang, title, origin) values (${src.id}, 'ja', 't', 'human')`;
			await sql`insert into translations (source_note_id, target_lang, title, origin) values (${src.id}, 'zh-cn', 't', 'machine')`;
			await sql`select set_config('c1.src', ${src.id}, true)`;
			await sql`select set_config('c1.post', ${post.id}, true)`;

			// Negatives: each must fail with the exact constraint name.
			await sql.unsafe(`
do $$
declare
	c text;
	s uuid := current_setting('c1.src')::uuid;
	p uuid := current_setting('c1.post')::uuid;
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
		insert into notes (content_format, lang) values ('markdown', 'xx');
		raise exception 'FAIL notes_lang_check accepted xx';
	exception when check_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_lang_check' then raise exception 'FAIL notes.lang: wrong constraint %', c; end if;
	end;

	begin
		insert into notes (content_format, translation_origin) values ('markdown', 'x');
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
		insert into notes (content_format, lang, slug) values ('markdown', 'ja', 'c1-dup');
		insert into notes (content_format, lang, slug) values ('markdown', 'ja', 'c1-dup');
		raise exception 'FAIL notes_lang_slug_uniq accepted a duplicate (lang, slug)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_lang_slug_uniq' then raise exception 'FAIL (lang,slug): wrong constraint %', c; end if;
	end;

	begin
		g := 'bbbb2222-0000-0000-0000-000000000001';
		insert into notes (content_format, lang, translation_group) values ('markdown', 'zh-cn', g);
		insert into notes (content_format, lang, translation_group, translated_from_note_id)
			values ('markdown', 'ja', g, s);
		insert into notes (content_format, lang, translation_group, translated_from_note_id)
			values ('markdown', 'ja', g, s);
		raise exception 'FAIL notes_translation_group_lang_uniq accepted a duplicate (group, lang)';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_translation_group_lang_uniq' then raise exception 'FAIL (group,lang): wrong constraint %', c; end if;
	end;

	begin
		g := 'bbbb2222-0000-0000-0000-000000000002';
		insert into notes (content_format, lang, translation_group) values ('markdown', 'en', g);
		insert into notes (content_format, lang, translation_group) values ('markdown', 'ja', g);
		raise exception 'FAIL notes_group_source_uniq accepted a second source';
	exception when unique_violation then
		get stacked diagnostics c = constraint_name;
		if c <> 'notes_group_source_uniq' then raise exception 'FAIL second source: wrong constraint %', c; end if;
	end;

	begin
		select nid into src_nid from notes where id = s;
		insert into notes (content_format, nid) values ('markdown', src_nid);
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

	-- Source-deletion trap (ledger §17): with >=2 translated rows in the group
	-- the DB refuses deleting the source (SET NULL would collide with
	-- notes_group_source_uniq). With exactly one translated row the delete
	-- currently succeeds and that row silently becomes the group source -
	-- registered behaviour, application-level group flow handles it first.
	begin
		g := 'bbbb2222-0000-0000-0000-000000000003';
		insert into notes (content_format, lang, translation_group) values ('markdown', 'en', g) returning id into s2;
		insert into notes (content_format, lang, translation_group, translated_from_note_id)
			values ('markdown', 'ja', g, s2), ('markdown', 'zh-cn', g, s2);
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

main().catch((error) => {
	console.error('✗ verify-baseline failed:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
});

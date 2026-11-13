import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeSchema, scanAuthTableMutations, schemaDrift } from './auth-schema-guard.ts';

describe('auth schema migration scan (H1)', () => {
	it('rejects ALTER/DROP/index statements that target a generated table', () => {
		expect(scanAuthTableMutations('alter table "user" add column x text;')).toHaveLength(1);
		expect(scanAuthTableMutations('ALTER TABLE session DROP COLUMN token;')).toHaveLength(1);
		expect(scanAuthTableMutations('drop table if exists "account";')).toHaveLength(1);
		expect(scanAuthTableMutations('create index idx on "session" ("user_id");')).toHaveLength(1);
		expect(
			scanAuthTableMutations('create unique index idx on "two_factor" ("user_id");')
		).toHaveLength(1);
	});

	it('rejects schema-qualified statements on a generated table', () => {
		expect(scanAuthTableMutations('alter table "public"."user" add column x text;')).toHaveLength(
			1
		);
		expect(scanAuthTableMutations('drop table if exists public.session;')).toHaveLength(1);
		expect(
			scanAuthTableMutations('create index idx on "public"."two_factor" ("user_id");')
		).toHaveLength(1);
	});

	it('allows our own tables, including foreign keys that point at auth tables', () => {
		const sql = `
			alter table "ai_provider_secrets" add constraint fk foreign key ("updated_by") references "user"("id");
			alter table "webhook_secrets" alter column "secret" drop not null;
			create index idx on "webhooks" ("is_enabled");
			create table "user" ("id" text primary key);
		`;
		expect(scanAuthTableMutations(sql)).toEqual([]);
	});

	it('ignores commented-out statements', () => {
		expect(scanAuthTableMutations('-- alter table "user" add column x text;\nselect 1;')).toEqual(
			[]
		);
	});

	it('reports the offending statement without truncating the table name', () => {
		const [offender] = scanAuthTableMutations('ALTER TABLE "two_factor" ADD COLUMN x text;');
		expect(offender).toMatchObject({ table: 'two_factor' });
		expect(offender.reason).toContain('ALTER TABLE');
	});
});

describe('schema drift (H1)', () => {
	it('ignores line endings and trailing whitespace', () => {
		expect(schemaDrift('a\r\nb  \r\n', 'a\nb\n')).toBeNull();
		expect(normalizeSchema('a\r\nb  \r\n')).toBe('a\nb\n');
	});

	it('reports the first differing line', () => {
		expect(schemaDrift('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
			line: 2,
			expected: 'b',
			actual: 'B'
		});
		expect(schemaDrift('a\n', 'a\nb\n')).toEqual({
			line: 2,
			expected: '<end of file>',
			actual: 'b'
		});
	});
});

describe('the repository passes its own guard', () => {
	const root = process.cwd();

	it('no migration alters or drops a generated auth table (structural DDL only)', () => {
		const dir = join(root, 'drizzle');
		// The baseline IS the generated initial schema (it necessarily creates
		// the tables and their foreign keys); every LATER migration is a hand
		// change and must not touch them.
		const offenders = readdirSync(dir)
			.filter((file) => file.endsWith('.sql') && file !== '0000_baseline.sql')
			.flatMap((file) =>
				scanAuthTableMutations(readFileSync(join(dir, file), 'utf8')).map((entry) => ({
					file,
					...entry
				}))
			);
		expect(offenders).toEqual([]);
	});
});

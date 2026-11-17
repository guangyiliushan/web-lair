/**
 * H1 guard logic for the generated better-auth schema.
 *
 * Pure functions so the CI script and the unit tests share one definition of
 * "drift" and "auth-table mutation". The script
 * (`scripts/auth-schema-guard.ts`) owns the CLI invocation and file walking;
 * the H3 source scan lives in `auth-customization-guard.ts`.
 */

/** Tables better-auth generates and upgrades itself (SQL identifiers). */
export const AUTH_TABLES = [
	'user',
	'session',
	'account',
	'verification',
	'two_factor',
	'passkey',
	'organization',
	'member',
	'invitation'
] as const;

export type AuthTable = (typeof AUTH_TABLES)[number];

const AUTH_TABLE_SET = new Set<string>(AUTH_TABLES);

export interface SqlOffender {
	table: string;
	statement: string;
	reason: string;
}

/** Strip `--` line comments so a commented-out ALTER cannot pass or fail. */
function stripComments(sql: string): string {
	return sql
		.split('\n')
		.map((line) => {
			const index = line.indexOf('--');
			return index >= 0 ? line.slice(0, index) : line;
		})
		.join('\n');
}

/**
 * Reject a migration that changes an auth table's STRUCTURE. `CREATE TABLE` of
 * a generated table is allowed (the baseline is generated output); `ALTER`,
 * `DROP`, and indexes/constraints attached to an auth table are not.
 */
export function scanAuthTableMutations(sql: string): SqlOffender[] {
	const offenders: SqlOffender[] = [];
	for (const rawStatement of stripComments(sql).split(';')) {
		const statement = rawStatement.trim().replace(/\s+/g, ' ');
		if (statement === '') continue;
		const lower = statement.toLowerCase();

		// Optional schema qualifier (`"public"."user"`, `public.session`); the
		// captured identifier is still the LAST one.
		const qualifier = '(?:["`]?[a-z0-9_]+["`]?\\s*\\.\\s*)?';
		const quoted = '["`]?([a-z0-9_]+)["`]?';
		const alter = lower.match(
			new RegExp('^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?' + qualifier + quoted)
		);
		if (alter && AUTH_TABLE_SET.has(alter[1])) {
			offenders.push({ table: alter[1], statement, reason: 'ALTER TABLE on a generated table' });
			continue;
		}
		const dropTable = lower.match(
			new RegExp('^drop\\s+table\\s+(?:if\\s+exists\\s+)?' + qualifier + quoted)
		);
		if (dropTable && AUTH_TABLE_SET.has(dropTable[1])) {
			offenders.push({ table: dropTable[1], statement, reason: 'DROP TABLE on a generated table' });
			continue;
		}
		const index = lower.match(
			new RegExp(
				'^create\\s+(?:unique\\s+)?index\\s+(?:concurrently\\s+)?(?:if\\s+not\\s+exists\\s+)?[a-z0-9_"`.]+\\s+on\\s+(?:only\\s+)?' +
					qualifier +
					quoted
			)
		);
		if (index && AUTH_TABLE_SET.has(index[1])) {
			offenders.push({ table: index[1], statement, reason: 'CREATE INDEX on a generated table' });
		}
	}
	return offenders;
}

/** Schema text with platform noise removed, for a byte-stable comparison. */
export function normalizeSchema(text: string): string {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/[ \t]+$/gm, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
		.concat('\n');
}

export interface SchemaDrift {
	line: number;
	expected: string;
	actual: string;
}

/** First differing line (1-based) between the committed and regenerated file. */
export function schemaDrift(committed: string, regenerated: string): SchemaDrift | null {
	const expected = normalizeSchema(committed).replace(/\n$/, '').split('\n');
	const actual = normalizeSchema(regenerated).replace(/\n$/, '').split('\n');
	const length = Math.max(expected.length, actual.length);
	for (let index = 0; index < length; index += 1) {
		if (expected[index] !== actual[index]) {
			return {
				line: index + 1,
				expected: expected[index] ?? '<end of file>',
				actual: actual[index] ?? '<end of file>'
			};
		}
	}
	return null;
}

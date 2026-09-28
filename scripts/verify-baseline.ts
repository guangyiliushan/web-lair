import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASELINE_PATH = fileURLToPath(new URL('../drizzle/0000_baseline.sql', import.meta.url));
const EXPECTED_TABLES = 52;
const LEGACY_INDEX_NAMES = new Set([
	// Removed by the queued SY batch; retained only for the current 52-table state.
	'poll_vote_options_pk'
]);
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

function fail(message: string): never {
	throw new Error(message);
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
	return [...text.matchAll(pattern)].map((match) => match[1]);
}

async function main(): Promise<void> {
	const baseline = readFileSync(BASELINE_PATH);
	const sha = createHash('sha256').update(baseline).digest('hex');
	const sqlText = baseline.toString('utf8');

	const tables = uniqueMatches(sqlText, /CREATE TABLE "([^"]+)"/g);
	if (tables.length !== EXPECTED_TABLES) {
		fail(`table count = ${tables.length}, expected ${EXPECTED_TABLES}`);
	}
	if (/CONCURRENTLY/i.test(sqlText)) fail('baseline contains CONCURRENTLY');

	for (const identifier of uniqueMatches(sqlText, /"([^"]+)"/g)) {
		if (Buffer.byteLength(identifier, 'utf8') > 63) {
			fail(`identifier exceeds 63 bytes: ${identifier}`);
		}
	}

	const indexes = [...sqlText.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"/g)];
	for (const [, name, table] of indexes) {
		if (OFFICIAL_GENERATED_TABLES.has(table)) continue;
		if (!LEGACY_INDEX_NAMES.has(name) && !name.endsWith('_idx') && !name.endsWith('_uniq')) {
			fail(`index name violates naming contract: ${name}`);
		}
	}

	const checks = [
		...sqlText.matchAll(/ADD CONSTRAINT "([^"]+)" CHECK/g),
		...sqlText.matchAll(/CONSTRAINT "([^"]+)" CHECK/g)
	];
	for (const [, name] of checks) {
		if (!name.endsWith('_check')) fail(`check name violates naming contract: ${name}`);
	}

	const foreignKeys = [...sqlText.matchAll(/ADD CONSTRAINT "([^"]+)" FOREIGN KEY/g)];
	for (const [, name] of foreignKeys) {
		if (!name.endsWith('_fk')) fail(`foreign-key name violates naming contract: ${name}`);
	}

	const requiredPageChecks = [
		'pages_status_check',
		'pages_external_url_check',
		'pages_title_object_check',
		'pages_description_object_check',
		'pages_content_object_check',
		'pages_content_format_check'
	];
	for (const name of requiredPageChecks) {
		if (!checks.some(([, constraint]) => constraint === name)) fail(`missing check: ${name}`);
	}

	console.log(
		`✓ verified baseline: sha256=${sha} tables=${tables.length} indexes=${indexes.length} checks=${checks.length} fks=${foreignKeys.length}`
	);
}

main().catch((error) => {
	console.error(`✗ ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});

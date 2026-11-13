/**
 * H1/H3 CI guard (W2.7 / W2.9).
 *
 * 1. Regenerates the better-auth schema into a temp file and compares it with
 *    `src/lib/server/db/auth.schema.ts` (normalized: line endings and trailing
 *    whitespace do not count, a missing/extra line does).
 * 2. Scans every migration for a structural change to a generated auth table.
 * 3. Scans production source for the H3 exclusions (custom token/backup-code
 *    hashing, custom 2FA challenge, hand-written adapter).
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/auth-schema-guard.ts
 *   node scripts/auth-schema-guard.ts --migrations-only   # no CLI, no network
 *
 * Exit codes: 0 = clean, 1 = drift/offender, 2 = the guard could not run.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format as prettierFormat, resolveConfig as prettierConfig } from 'prettier';
import {
	scanAuthTableMutations,
	schemaDrift
} from '../src/lib/server/db/auth-schema-guard.ts';
import { scanForbiddenAuthCustomizations } from '../src/lib/server/db/auth-customization-guard.ts';

const MIGRATIONS_ONLY = process.argv.includes('--migrations-only');
const root = process.cwd();
let failed = false;

// ---- 2) Migration SQL scan (always runs) ----------------------------------
try {
	const dir = join(root, 'drizzle');
	for (const file of readdirSync(dir).filter(
		(name) => name.endsWith('.sql') && name !== '0000_baseline.sql'
	)) {
		const offenders = scanAuthTableMutations(readFileSync(join(dir, file), 'utf8'));
		for (const offender of offenders) {
			failed = true;
			console.error(
				`[auth-guard] ${file}: ${offender.reason} (${offender.table})\n  ${offender.statement}`
			);
		}
	}
	if (!failed) console.log('[auth-guard] migrations: no auth-table structural change');
} catch (error) {
	console.error(
		'[auth-guard] could not scan migrations:',
		error instanceof Error ? error.message : error
	);
	process.exit(2);
}

// ---- 3) H3 source scan (always runs) --------------------------------------
try {
	const files: Array<{ path: string; text: string }> = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!/\.(ts|svelte)$/.test(path)) continue;
			if (/\.(test|spec)\.ts$/.test(path)) continue;
			files.push({ path, text: readFileSync(path, 'utf8') });
		}
	};
	walk(join(root, 'src'));
	const matches = scanForbiddenAuthCustomizations(files);
	for (const match of matches) {
		failed = true;
		console.error(`[auth-guard] ${match.path}:${match.line}: forbidden ${match.pattern}`);
	}
	if (matches.length === 0) console.log('[auth-guard] source: no H3 exclusion found');
} catch (error) {
	console.error(
		'[auth-guard] could not scan source:',
		error instanceof Error ? error.message : error
	);
	process.exit(2);
}

// ---- 1) Schema drift (needs the auth CLI) --------------------------------
if (!MIGRATIONS_ONLY) {
	const committedPath = join(root, 'src/lib/server/db/auth.schema.ts');
	const tempDir = mkdtempSync(join(tmpdir(), 'wl-auth-schema-'));
	const outputPath = join(tempDir, 'auth.schema.ts');
	try {
		execFileSync(
			process.platform === 'win32' ? 'npx.cmd' : 'npx',
			[
				'--yes',
				'auth@1.7.5',
				'generate',
				'--config',
				'src/lib/server/auth.ts',
				'--output',
				outputPath,
				'--yes'
			],
			{
				cwd: root,
				stdio: ['ignore', 'pipe', 'pipe'],
				// Node cannot spawn a `.cmd` shim directly on Windows (EINVAL);
				// the command is fixed, so a shell adds no injection surface.
				shell: process.platform === 'win32',
				env: {
					...process.env,
					// Import-time placeholders only: this command introspects the
					// config, it never connects.
					DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://guard:guard@127.0.0.1:5432/guard',
					ORIGIN: process.env.ORIGIN ?? 'http://localhost:4173',
					BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'x'.repeat(32)
				}
			}
		);
		// The committed file is Prettier-formatted (the repo's `pnpm auth:schema`
		// is followed by `pnpm format`); format the temp copy the same way so
		// quote style alone is not reported as drift.
		const config = (await prettierConfig(committedPath)) ?? {};
		const regenerated = await prettierFormat(readFileSync(outputPath, 'utf8'), {
			...config,
			parser: 'typescript'
		});
		const drift = schemaDrift(readFileSync(committedPath, 'utf8'), regenerated);
		if (drift) {
			failed = true;
			console.error(`[auth-guard] auth.schema.ts drifted at line ${drift.line}`);
			console.error(`  committed:   ${drift.expected}`);
			console.error(`  regenerated: ${drift.actual}`);
			console.error('  Fix: pnpm auth:schema (and commit the generated file).');
		} else {
			console.log('[auth-guard] auth.schema.ts matches the generated output');
		}
	} catch (error) {
		// A guard that cannot run must fail loudly, not report a clean tree.
		console.error(
			'[auth-guard] could not regenerate the schema:',
			error instanceof Error ? error.message : error
		);
		process.exit(2);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

if (failed) process.exit(1);
console.log('[auth-guard] ok');

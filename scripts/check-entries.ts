/**
 * Entry contract check (CI gate).
 *
 * Asserts:
 *   1. the manifest has no duplicate ids and every file exists;
 *   2. every runtime=node entry's import closure has no `$lib`/`$app` and no
 *      extensionless relative import;
 *   3. deploy hooks only reference existing runtime=node entries;
 *   4. package.json scripts keep only official/third-party passthroughs + `ops`;
 *   5. removed aliases leave no residue in docs or sources;
 *   6. docs no longer call `node scripts/...` directly (it must go through lair).
 *
 * This file must stay node-pure (CI and the container execute it directly).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, GROUPS } from './manifest.ts';
import { DEPLOY_HOOKS } from './deploy-hooks.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Official/third-party passthroughs allowed in package.json. */
const ALLOWED_SCRIPTS = new Set([
	'dev',
	'build',
	'preview',
	'prepare',
	'check',
	'check:watch',
	'lint',
	'format',
	'test',
	'test:unit',
	'test:e2e',
	'test:integration-refs',
	'test:storage-live',
	'storybook',
	'build-storybook',
	'db:start',
	'db:push',
	'db:generate',
	'db:migrate',
	'db:studio',
	'auth:schema',
	'verify:image',
	'ops'
]);

/** Aliases removed by this consolidation: must not reappear in docs or sources. */
const REMOVED_ALIASES = [
	'db:seed-owner',
	'owner:rebuild',
	'db:seed-demo',
	'db:verify-owner',
	'db:reset-2fa',
	'db:ensure-org',
	'db:verify-review',
	'db:verify-baseline',
	'db:backfill-grid',
	'db:backfill-refs',
	'db:backfill-translation-slug',
	'db:backfill-consent',
	'db:backfill-suppressions',
	'db:verify-suppression-version',
	'db:verify-jobs',
	'jobs:drain',
	'jobs:dev',
	'jobs:enqueue',
	'jobs:check-links',
	'jobs:links-prune',
	'jobs:revisions-prune',
	'jobs:orphans-purge',
	'jobs:trash-purge',
	'jobs:sync-projects',
	'db:ensure-categories',
	'db:ensure-pages',
	'db:ensure-schedules',
	'db:verify-pages',
	'storage:smoke',
	'storage:migrate',
	'e2e:overlay-fixtures',
	'media:audit',
	'media:import',
	'maps:publish',
	'media:purge',
	'db:verify-media',
	'secrets:alerts',
	'db:migrate-webhook-secrets',
	'auth:check',
	'auth:check:migrations',
	'secrets:verify-keys',
	'lint:tw',
	'db:migrate:prod'
];

const violations: string[] = [];

function v(where: string, message: string): void {
	violations.push(`${where}: ${message}`);
}

// --- 1. manifest itself -----------------------------------------------------

const seen = new Set<string>();
for (const e of ENTRIES) {
	const id = `${e.group} ${e.name}`;
	if (seen.has(id)) v('manifest', `duplicate entry: ${id}`);
	seen.add(id);
	if (!GROUPS.some((g) => g.id === e.group)) v('manifest', `unknown group in ${id}`);
	if (!existsSync(path.join(ROOT, e.file))) v('manifest', `${id} -> missing file ${e.file}`);
}

// --- 2. closure check for runtime=node --------------------------------------

function resolveSpec(from: string, spec: string): { file: string | null; hasExt: boolean } {
	const base = path.resolve(path.dirname(from), spec);
	const hasExt = path.extname(spec) !== '';
	const candidates = [base, base + '.ts', path.join(base, 'index.ts')];
	for (const c of candidates) {
		if (existsSync(c) && statSync(c).isFile()) return { file: c, hasExt };
	}
	return { file: null, hasExt };
}

function closureProblems(entryFile: string): string[] {
	const problems: string[] = [];
	const queue = [path.resolve(ROOT, entryFile)];
	const seenFiles = new Set<string>();
	while (queue.length) {
		const file = queue.shift()!;
		if (seenFiles.has(file) || !file.endsWith('.ts') || !existsSync(file)) continue;
		seenFiles.add(file);
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)) {
			const spec = m[1];
			if (spec.startsWith('$')) {
				problems.push(`alias import '${spec}' in ${path.relative(ROOT, file)}`);
				continue;
			}
			if (!spec.startsWith('.')) continue;
			const r = resolveSpec(file, spec);
			if (!r.hasExt)
				problems.push(`extensionless import '${spec}' in ${path.relative(ROOT, file)}`);
			if (r.file) queue.push(r.file);
			else problems.push(`unresolved import '${spec}' in ${path.relative(ROOT, file)}`);
		}
	}
	return problems;
}

for (const e of ENTRIES) {
	if (e.runtime !== 'node') continue;
	for (const p of closureProblems(e.file)) v(`${e.group} ${e.name}`, p);
}

// cli.ts is the launcher inside the image: the runtime stage copies only
// scripts/ + bin/, so its import closure must not reach anything outside
// scripts/ (deploy/ is not shipped).
{
	const queue = [path.resolve(ROOT, 'scripts/cli.ts')];
	const seenFiles = new Set<string>();
	while (queue.length) {
		const file = queue.shift()!;
		if (seenFiles.has(file) || !file.endsWith('.ts') || !existsSync(file)) continue;
		seenFiles.add(file);
		const rel = path.relative(ROOT, file).replace(/\\/g, '/');
		if (!rel.startsWith('scripts/')) {
			v('scripts/cli.ts', `closure escapes scripts/ -> ${rel} (not shipped in the runtime image)`);
			continue;
		}
		const src = readFileSync(file, 'utf8');
		for (const m of src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)) {
			if (!m[1].startsWith('.')) continue;
			const r = resolveSpec(file, m[1]);
			if (r.file) queue.push(r.file);
		}
	}
}

// --- 3. deploy hooks --------------------------------------------------------

for (const phase of ['pre', 'post'] as const) {
	for (const hook of DEPLOY_HOOKS[phase]) {
		const [group, name] = hook.command.split(' ');
		const e = ENTRIES.find((x) => x.group === group && x.name === name);
		if (!e) {
			v('scripts/deploy-hooks.ts', `${phase}: unknown entry '${hook.command}'`);
			continue;
		}
		if (e.runtime !== 'node')
			v('scripts/deploy-hooks.ts', `${phase}: '${hook.command}' is not node-runnable`);
	}
}

// --- 4. package.json --------------------------------------------------------

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
for (const key of Object.keys(pkg.scripts)) {
	if (!ALLOWED_SCRIPTS.has(key))
		v('package.json', `unexpected script '${key}' (move it to the manifest)`);
}
for (const key of ALLOWED_SCRIPTS) {
	if (!(key in pkg.scripts)) v('package.json', `missing allowed script '${key}'`);
}

// --- 5/6. docs and sources residue ------------------------------------------

const SKIP_DIRS = new Set([
	'node_modules',
	'.git',
	'.svelte-kit',
	'build',
	'storybook-static',
	'test-results',
	'.vite',
	'coverage'
]);
const SCAN_EXTS = new Set([
	'.ts',
	'.js',
	'.svelte',
	'.json',
	'.md',
	'.yml',
	'.yaml',
	'.sh',
	'.service',
	'.example',
	'.env'
]);
const SCAN_FILES = [
	'README.md',
	'.env.example',
	'package.json',
	'Dockerfile',
	'compose.yaml',
	'compose.prod.yaml'
];

const aliasRe = new RegExp(
	`\\bpnpm\\s+(?:run\\s+)?(${REMOVED_ALIASES.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w:-])`,
	'g'
);

/** Bare command names (old names used in UI copy or comments, without `pnpm`). */
const bareRe = new RegExp(
	`(?<![\\w:.-])(${REMOVED_ALIASES.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w:-])`,
	'g'
);

function lineOf(text: string, index: number): number {
	let n = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

function scanFile(file: string): void {
	const rel = path.relative(ROOT, file).replace(/\\/g, '/');
	// Generated paraglide output and this checker itself (it embeds the alias list).
	if (rel.startsWith('src/lib/paraglide/') || rel.startsWith('src/paraglide/')) return;
	if (rel === 'scripts/check-entries.ts') return;
	const text = readFileSync(file, 'utf8');
	aliasRe.lastIndex = 0;
	for (const m of text.matchAll(aliasRe)) {
		v(`${rel}:${lineOf(text, m.index ?? 0)}`, `references removed alias 'pnpm ${m[1]}'`);
	}
	bareRe.lastIndex = 0;
	for (const m of text.matchAll(bareRe)) {
		const idx = m.index ?? 0;
		const before = text.slice(Math.max(0, idx - 8), idx);
		if (/pnpm\s+$/.test(before)) continue; // already reported above
		v(`${rel}:${lineOf(text, idx)}`, `stale command name '${m[1]}' — use 'lair <group> <cmd>'`);
	}
	if (rel === 'deploy/RUNBOOK.md') {
		// `node jobs/drain.ts` is deliberately allowed: it mirrors the systemd
		// ExecStart line, which stays on the direct path by decision D11.
		for (const m of text.matchAll(/\bnode\s+(?:\.\/)?scripts\/[\w./-]+\.ts/g)) {
			v(
				`${rel}:${lineOf(text, m.index ?? 0)}`,
				`direct node invocation '${m[0]}' — use 'node bin/lair <group> <cmd>'`
			);
		}
	}
}

function walk(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const full = path.join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			walk(full);
			continue;
		}
		const ext = path.extname(full);
		if (!SCAN_EXTS.has(ext) && !SCAN_FILES.includes(path.relative(ROOT, full).replace(/\\/g, '/')))
			continue;
		if (st.size > 2_000_000) continue;
		scanFile(full);
	}
}

for (const f of SCAN_FILES) {
	const full = path.join(ROOT, f);
	if (existsSync(full)) scanFile(full);
}
for (const dir of ['src', 'scripts', 'e2e', 'messages', 'deploy', '.github', 'jobs']) {
	const full = path.join(ROOT, dir);
	if (existsSync(full)) walk(full);
}

// --- result -----------------------------------------------------------------

if (violations.length > 0) {
	console.error(`entry contract: ${violations.length} violation(s)`);
	for (const line of violations) console.error(`  - ${line}`);
	process.exit(1);
}
console.log(
	`entry contract: OK — ${ENTRIES.length} entries, ${GROUPS.length} groups, ${Object.keys(pkg.scripts).length} package.json scripts`
);

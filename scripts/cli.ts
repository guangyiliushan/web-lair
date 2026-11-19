/**
 * Ops CLI runner.
 *
 * Constraints:
 * - must stay node-pure (explicit `.ts` imports, no `$lib`): the container has no tsx;
 * - no business argument parsing: arguments are forwarded to the target script verbatim;
 * - exit codes pass through (signals map to 128+n);
 * - mutating commands print the target database (credentials stripped) before spawning.
 *
 * Usage:
 *   node bin/lair                         grouped help
 *   node bin/lair --list [--json]         every command
 *   node bin/lair <group>                 group help
 *   node bin/lair <group> <name> [...]    run (arguments forwarded)
 *   node bin/lair <group> <name> --print  print the command line only
 *   node bin/lair deploy pre|post [--print]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, GROUPS, findEntry, entryId } from './manifest.ts';
import { DEPLOY_HOOKS } from './deploy-hooks.ts';
import type { Entry } from './manifest.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOT_ENV = path.join(ROOT, '.env');

function fail(message: string): never {
	console.error(`lair: ${message}`);
	process.exit(2);
}

function pad(s: string, n: number): string {
	return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length);
}

function marker(e: Entry): string {
	if (e.danger) return '!';
	if (e.mutates) return '*';
	return ' ';
}

function printAll(entries: Entry[]): void {
	for (const g of GROUPS) {
		const rows = entries.filter((e) => e.group === g.id);
		if (rows.length === 0) continue;
		console.log(`\n${g.id} — ${g.title}`);
		for (const e of rows.sort((a, b) => a.name.localeCompare(b.name))) {
			const flags = [e.runtime === 'tsx' ? 'tsx' : 'node'];
			if (e.dryRun) flags.push('dry-run 默认');
			console.log(`  ${marker(e)} ${pad(e.name, 30)} ${e.summary}  [${flags.join(', ')}]`);
		}
	}
	console.log('\n  * 写库/写存储   ! 破坏性操作');
	console.log('  运行：node bin/lair <group> <name> [args...]   展开：--print');
}

function printGroup(group: string): void {
	const g = GROUPS.find((x) => x.id === group);
	if (!g) fail(`unknown group: ${group}`);
	const rows = ENTRIES.filter((e) => e.group === g.id).sort((a, b) => a.name.localeCompare(b.name));
	console.log(`${g.id} — ${g.title}`);
	for (const e of rows) {
		const flags = [e.runtime === 'tsx' ? 'tsx' : 'node'];
		if (e.dryRun) flags.push('dry-run 默认');
		if (e.danger) flags.push('破坏性');
		console.log(`  ${pad(e.name, 30)} ${e.summary}  [${flags.join(', ')}]`);
	}
	if (g.id === 'db')
		console.log('\n  migrate-prod = 运行时迁移；开发用 pnpm db:migrate（drizzle-kit）');
}

/** Prefer `.env` when present, otherwise the process env - mirrors the --env-file choice. */
function databaseUrl(): { url: string | null; from: string } {
	if (existsSync(DOT_ENV)) {
		const line = readFileSync(DOT_ENV, 'utf8')
			.split(/\r?\n/)
			.find((l) => /^\s*DATABASE_URL\s*=/.test(l));
		if (line)
			return {
				url: line.replace(/^\s*DATABASE_URL\s*=\s*/, '').replace(/^["']|["']$/g, ''),
				from: '.env'
			};
	}
	const v = process.env.DATABASE_URL;
	return { url: v ?? null, from: v ? 'process.env' : 'unset' };
}

function targetLine(): string {
	const { url, from } = databaseUrl();
	if (!url) return `target: DATABASE_URL ${from}`;
	try {
		const u = new URL(url);
		return `target: ${u.hostname}:${u.port || '5432'}${u.pathname} (${from})`;
	} catch {
		return `target: (unparsable DATABASE_URL, ${from})`;
	}
}

/** Env selection: inject only when the repo root has .env; otherwise assume compose/systemd/CI provided it. */
function envArgs(e: Entry): string[] {
	if (e.env === 'none') return [];
	if (!existsSync(DOT_ENV)) return [];
	return [e.env === 'required' ? '--env-file=.env' : '--env-file-if-exists=.env'];
}

/** Checked only right before spawning: --print must work without an environment. */
function assertEnv(e: Entry): void {
	if (e.env === 'none') return;
	if (!existsSync(DOT_ENV) && e.env === 'required' && !process.env.DATABASE_URL) {
		fail(`缺少 .env 且未设置 DATABASE_URL；${entryId(e)} 需要数据库环境`);
	}
}

function commandLine(e: Entry, args: string[]): string[] {
	const env = envArgs(e);
	const runtimeArgs = e.runtime === 'tsx' ? ['--import=tsx', e.file] : [e.file];
	return [...env, ...runtimeArgs, ...args];
}

function run(e: Entry, args: string[], printOnly: boolean): void {
	const line = commandLine(e, args);
	const printable = ['node', ...line].join(' ');
	if (printOnly) {
		console.log(printable);
		return;
	}
	if (e.mutates) console.log(targetLine());
	assertEnv(e);
	const child = spawn(process.execPath, line, { cwd: ROOT, stdio: 'inherit' });
	const forward = (sig: NodeJS.Signals) => () => {
		if (!child.killed) child.kill(sig);
	};
	process.on('SIGINT', forward('SIGINT'));
	process.on('SIGTERM', forward('SIGTERM'));
	child.on('exit', (code, signal) => {
		if (signal) {
			const n = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
			process.exit(n);
		}
		process.exit(code ?? 1);
	});
	child.on('error', (err) => {
		console.error(`lair: failed to spawn: ${err.message}`);
		process.exit(1);
	});
}

function runDeploy(phase: string, rest: string[]): void {
	const hooks = DEPLOY_HOOKS[phase as 'pre' | 'post'];
	if (!hooks) fail(`unknown deploy phase: ${phase} (expected pre|post)`);
	const printOnly = rest.includes('--print');
	const resolved = hooks.map((h) => {
		const [group, name] = h.command.split(' ');
		const e = findEntry(group, name);
		if (!e) fail(`deploy hook references unknown entry: ${h.command}`);
		if (e.runtime !== 'node') fail(`deploy hook must be node-runnable: ${h.command}`);
		return { hook: h, entry: e };
	});
	if (printOnly) {
		for (const r of resolved)
			console.log(`node ${commandLine(r.entry, []).join(' ')}   # ${r.hook.note}`);
		return;
	}
	let i = 0;
	const next = () => {
		if (i >= resolved.length) {
			console.log(`lair: deploy ${phase} complete (${resolved.length} steps)`);
			return;
		}
		const { hook, entry } = resolved[i++];
		console.log(`\n==> [${i}/${resolved.length}] lair ${hook.command} — ${hook.note}`);
		const line = commandLine(entry, []);
		if (entry.mutates) console.log(targetLine());
		const child = spawn(process.execPath, line, { cwd: ROOT, stdio: 'inherit' });
		child.on('exit', (code, signal) => {
			if (signal || (code ?? 1) !== 0) {
				console.error(`lair: deploy ${phase} failed at ${hook.command} (exit ${code ?? signal})`);
				process.exit(code ?? 1);
			}
			next();
		});
	};
	next();
}

function main(argv: string[]): void {
	if (argv.length === 0) {
		printAll(ENTRIES);
		return;
	}
	const [head, second, ...rest] = argv;
	if (head === '--help' || head === '-h') {
		printAll(ENTRIES);
		return;
	}
	if (head === '--list') {
		if (second === '--json') {
			console.log(JSON.stringify({ groups: GROUPS, entries: ENTRIES }, null, 2));
			return;
		}
		printAll(ENTRIES);
		return;
	}
	if (head === 'deploy') {
		if (!second) fail('usage: node bin/lair deploy pre|post [--print]');
		runDeploy(second, rest);
		return;
	}
	const group = GROUPS.find((g) => g.id === head);
	if (!group) fail(`unknown group: ${head} (groups: ${GROUPS.map((g) => g.id).join(', ')})`);
	if (!second) {
		printGroup(head);
		return;
	}
	const entry = findEntry(head, second);
	if (!entry) fail(`unknown command: ${head} ${second}`);
	const entryArgs = rest.filter((a) => a !== '--print');
	run(entry, entryArgs, rest.includes('--print'));
}

main(process.argv.slice(2));

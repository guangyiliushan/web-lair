import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { jobsDir, repoRoot, resolveDataDir } from './data-dir.ts';
import { ensureJobsScaffold } from './scaffold.ts';
import { listUserJobFiles } from './user-layer.ts';

const execFileAsync = promisify(execFile);

/**
 * `jobs.typecheck` service (J-2, plan §4.11): runs `tsc --noEmit` against the
 * generated tsconfig for `$DATA_DIR/jobs` and returns a bounded diagnostic
 * summary for the run ledger. The save gate deliberately does NOT type-check
 * (plan §5.4) - this is where types get verified: on demand via the queued
 * job, never on the save path.
 *
 * The tsc binary comes from the repository's own typescript install
 * (deployment must keep typescript installed; plan §5.4) and is spawned with
 * this Node binary, so no PATH assumptions.
 */

export interface TypecheckIssue {
	file: string;
	line: number | null;
	column: number | null;
	message: string;
}

export interface TypecheckSummary {
	ok: boolean;
	fileCount: number;
	errorCount: number;
	/** Bounded diagnostics list for the ledger; the log carries the full set. */
	issues: TypecheckIssue[];
	timedOut: boolean;
	/** Set when the runner itself failed (tsc missing, spawn error). */
	runnerError: string | null;
}

const TSC_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const DEFAULT_MAX_ISSUES = 50;

/** Parse `tsc --pretty false` lines: `path(line,col): error TSxxxx: message`. */
export function parseTscDiagnostics(
	output: string,
	maxIssues = DEFAULT_MAX_ISSUES
): TypecheckIssue[] {
	const issues: TypecheckIssue[] = [];
	for (const rawLine of output.split(/\r?\n/)) {
		const match = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(rawLine.trim());
		if (!match) continue;
		issues.push({
			file: match[1],
			line: Number(match[2]),
			column: Number(match[3]),
			message: `TS${match[4]}: ${match[5]}`
		});
		if (issues.length >= maxIssues) break;
	}
	return issues;
}

export async function runJobsTypecheck(options?: {
	dataDir?: string;
	maxIssues?: number;
}): Promise<TypecheckSummary> {
	const dataDir = options?.dataDir ?? resolveDataDir();
	await ensureJobsScaffold(dataDir);
	const dir = jobsDir(dataDir);
	const files = await listUserJobFiles(dataDir);
	if (files.length === 0) {
		return {
			ok: true,
			fileCount: 0,
			errorCount: 0,
			issues: [],
			timedOut: false,
			runnerError: null
		};
	}
	const tscPath = join(repoRoot, 'node_modules', 'typescript', 'lib', 'tsc.js');
	let stdout: string;
	let timedOut = false;
	let runnerError: string | null = null;
	try {
		const result = await execFileAsync(
			process.execPath,
			[tscPath, '--noEmit', '--pretty', 'false', '-p', join(dir, 'tsconfig.json')],
			{ cwd: dir, timeout: TSC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }
		);
		stdout = result.stdout;
	} catch (error) {
		const candidate = error as {
			stdout?: string;
			killed?: boolean;
			signal?: string | number | null;
			code?: string;
			message?: string;
		};
		stdout = typeof candidate.stdout === 'string' ? candidate.stdout : '';
		if (candidate.killed === true || candidate.signal != null) {
			timedOut = true;
		} else if (stdout.length === 0) {
			// No diagnostics and a non-timeout non-zero exit: the runner itself
			// failed (tsc missing, spawn refused) - report it as such instead
			// of an empty "failed" that explains nothing.
			runnerError =
				candidate.code === 'ENOENT'
					? 'typescript is not installed in the repository'
					: (candidate.message ?? 'tsc invocation failed');
		}
	}
	const issues = parseTscDiagnostics(stdout, options?.maxIssues ?? DEFAULT_MAX_ISSUES);
	const errorLine = /Found (\d+) errors?/.exec(stdout);
	const errorCount = errorLine ? Number(errorLine[1]) : issues.length;
	return {
		ok: issues.length === 0 && errorCount === 0 && !timedOut && runnerError === null,
		fileCount: files.length,
		errorCount,
		issues,
		timedOut,
		runnerError
	};
}

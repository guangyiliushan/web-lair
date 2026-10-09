import { stripTypeScriptTypes } from 'node:module';
import { repoRoot } from './data-dir.ts';
import { isSafeJobName } from './loader.ts';
import type { CompilerOptions, Node as TypeScriptNode } from 'typescript';
import type { ESLint } from 'eslint';

/**
 * Save gate (J-2, plan §5.4; grill R2-1): every check a job script must pass
 * before it may be written to the user layer. All checks are pure "parsing" -
 * user code is never executed here; the drain is the only executor (plan §5.1).
 *
 * The checks and why (all probed 2026-10-07):
 *   1. name       - module-file safety (Windows device names, traversal) + length.
 *   2. typescript - parser + `erasableSyntaxOnly` diagnostics (TS 5.8+, the
 *                   option the TypeScript and Node docs pair for strip-only
 *                   mode). It is the only checker that reports line/column
 *                   for non-erasable syntax: node's `stripTypeScriptTypes`
 *                   throws WITHOUT a position.
 *   3. strip      - `module.stripTypeScriptTypes` is the runtime authority
 *                   (node's own amaro-based stripper). When it rejects and
 *                   the TS pass explained nothing, its message is the report.
 *   4. runtime    - constructs that pass type stripping yet are invalid when
 *                   node executes the stripped output (decorators). Rejected
 *                   here so a save cannot produce an unrunnable file.
 *   5. eslint     - `no-restricted-imports`: only `node:*` and `#jobs-sdk`
 *                   (fork-runnable, plan §5.5), with an isolated config - the
 *                   repository config is never consulted.
 */

export interface GateError {
	source: 'name' | 'typescript' | 'strip' | 'runtime' | 'eslint';
	/** 1-based; null when the checker cannot attribute a position. */
	line: number | null;
	column: number | null;
	message: string;
	/** TS error code, `ERR_*` code or eslint rule id, for the UI. */
	code?: string | number;
}

export interface GateReport {
	ok: boolean;
	errors: GateError[];
}

const MAX_JOB_NAME_LENGTH = 64;

/** Name rules (plan §5.4): module-file safe, traversal safe, bounded length. */
export function checkJobName(name: string): GateError[] {
	const errors: GateError[] = [];
	if (name.length > MAX_JOB_NAME_LENGTH) {
		errors.push({
			source: 'name',
			line: null,
			column: null,
			message: `job name is longer than ${MAX_JOB_NAME_LENGTH} characters`
		});
	}
	if (!isSafeJobName(name)) {
		errors.push({
			source: 'name',
			line: null,
			column: null,
			message: 'job name must match [a-z0-9][a-z0-9.-]* and must not be a Windows device name'
		});
	}
	return errors;
}

/**
 * Import policy for job files. The two node negations are deliberate:
 * minimatch never crosses "/" with a single `*`, so one-slash builtins such
 * as node:fs/promises need a second one-slash pattern on top of the bare
 * `node:*` negation (probed matrix). The builtin-side twin of this rule
 * lives in eslint.config.js.
 */
export const JOB_IMPORT_PATTERNS = [
	{
		group: ['**', '!node:*', '!node:*/*', '!*#jobs-sdk*'],
		message: 'only node:* modules and #jobs-sdk may be imported'
	}
];

// ---------------------------------------------------------------------------
// TypeScript diagnostics (positions for everything strip-only rejects)
// ---------------------------------------------------------------------------

type TsModule = typeof import('typescript');
let tsModulePromise: Promise<TsModule> | null = null;

function loadTypescript(): Promise<TsModule> {
	tsModulePromise ??= import('typescript');
	return tsModulePromise;
}

async function checkTypeScript(code: string): Promise<GateError[]> {
	const ts = await loadTypescript();
	const fileName = 'job-script.ts';
	const options: CompilerOptions = {
		noEmit: true,
		erasableSyntaxOnly: true,
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		skipLibCheck: true,
		types: []
	};
	const host = ts.createCompilerHost(options, true);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
		file === fileName
			? ts.createSourceFile(file, code, languageVersion, true, ts.ScriptKind.TS)
			: originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
	host.writeFile = () => {};
	const program = ts.createProgram([fileName], options, host);
	// Only syntax / grammar-category diagnostics (1xxx): they cover both plain
	// parse errors (e.g. 1134) and every `erasableSyntaxOnly` rejection (1294).
	// Semantic codes (2xxx+) would flag module resolution that the save path
	// deliberately does not evaluate; the jobs.typecheck job covers types.
	const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
		const owned = !diagnostic.file || diagnostic.file.fileName === fileName;
		return owned && diagnostic.code >= 1000 && diagnostic.code < 2000;
	});
	return diagnostics.map((diagnostic) => {
		let line: number | null = null;
		let column: number | null = null;
		if (diagnostic.file && diagnostic.start !== undefined) {
			const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			line = position.line + 1;
			column = position.character + 1;
		}
		return {
			source: 'typescript' as const,
			line,
			column,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
			code: diagnostic.code
		};
	});
}

// ---------------------------------------------------------------------------
// Type stripping (runtime authority; no positions - probed)
// ---------------------------------------------------------------------------

function checkStrip(code: string): GateError[] {
	try {
		stripTypeScriptTypes(code, { mode: 'strip' });
		return [];
	} catch (error) {
		const candidate = error as { message?: string; code?: string };
		return [
			{
				source: 'strip',
				line: null,
				column: null,
				message: candidate.message ?? 'type stripping rejected the script',
				code: candidate.code
			}
		];
	}
}

// ---------------------------------------------------------------------------
// Runtime residue: decorators pass stripping, fail on execution
// ---------------------------------------------------------------------------

async function checkRuntimeResidue(code: string): Promise<GateError[]> {
	const ts = await loadTypescript();
	const sourceFile = ts.createSourceFile(
		'job-script.ts',
		code,
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.TS
	);
	const errors: GateError[] = [];
	const visit = (node: TypeScriptNode): void => {
		if (ts.canHaveDecorators(node)) {
			for (const decorator of ts.getDecorators(node) ?? []) {
				const position = sourceFile.getLineAndCharacterOfPosition(decorator.getStart(sourceFile));
				errors.push({
					source: 'runtime',
					line: position.line + 1,
					column: position.character + 1,
					message:
						'decorators pass type stripping but are not valid JavaScript at run time (strip-only mode)'
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return errors;
}

// ---------------------------------------------------------------------------
// Import policy (isolated eslint config - repo config never consulted)
// ---------------------------------------------------------------------------

let eslintPromise: Promise<ESLint> | null = null;

function loadEslint(): Promise<ESLint> {
	eslintPromise ??= (async () => {
		const { ESLint: ESLintClass } = await import('eslint');
		const tseslint = (await import('typescript-eslint')).default;
		return new ESLintClass({
			cwd: repoRoot,
			overrideConfigFile: true,
			overrideConfig: [
				{
					files: ['**/*.ts'],
					languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
					rules: { 'no-restricted-imports': ['error', { patterns: JOB_IMPORT_PATTERNS }] }
				}
			]
		});
	})();
	return eslintPromise;
}

async function checkEslintImports(code: string): Promise<GateError[]> {
	const eslint = await loadEslint();
	const [result] = await eslint.lintText(code, { filePath: 'job-script.ts' });
	return result.messages
		.filter((message) => message.ruleId === 'no-restricted-imports')
		.map((message) => ({
			source: 'eslint' as const,
			line: message.line ?? null,
			column: message.column ?? null,
			message: message.message,
			code: message.ruleId ?? undefined
		}));
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Run every check over a candidate script. The name is checked independently
 * of the code; TypeScript diagnostics provide the positions, node's stripper
 * fills in when TypeScript explained nothing.
 */
export async function runSaveGate(input: { name: string; code: string }): Promise<GateReport> {
	const errors: GateError[] = [...checkJobName(input.name)];
	const [tsErrors, runtimeErrors, eslintErrors] = await Promise.all([
		checkTypeScript(input.code),
		checkRuntimeResidue(input.code),
		checkEslintImports(input.code)
	]);
	const stripErrors = checkStrip(input.code);
	errors.push(...runtimeErrors, ...tsErrors, ...eslintErrors);
	if (stripErrors.length > 0 && tsErrors.length === 0) errors.push(...stripErrors);
	return { ok: errors.length === 0, errors };
}

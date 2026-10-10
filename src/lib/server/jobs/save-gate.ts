import { stripTypeScriptTypes } from 'node:module';
import { repoRoot } from './data-dir.ts';
import { JOB_IMPORT_PATTERNS, isAllowedImportSpecifier } from './import-policy.ts';
import { isSafeJobName } from './loader.ts';
import { isCanonicalJobName } from './user-layer.ts';
import type { CompilerOptions, Node as TypeScriptNode, SourceFile } from 'typescript';
import type { ESLint } from 'eslint';

/**
 * Save gate (J-2, plan §5.4; grill R2-1): every check a job script must pass
 * before it may be written to the user layer. All checks are pure "parsing" -
 * user code is never executed here; the drain is the only executor (plan §5.1).
 *
 * The checks and why (all probed 2026-10-07; hardened by the J-2 review):
 *   1. name       - module-file safety (Windows device names, traversal),
 *                   bounded length, and the canonical-name invariant: a name
 *                   must map to its own file (`my.job` would land in
 *                   `my-job.ts`; `jobs-prune` would silently shadow the
 *                   `jobs.prune` builtin without a fork sidecar).
 *   2. typescript - parser + `erasableSyntaxOnly` diagnostics (TS 5.8+, the
 *                   option the TypeScript and Node docs pair for strip-only
 *                   mode). It is the only checker that reports line/column
 *                   for non-erasable syntax: node's `stripTypeScriptTypes`
 *                   throws WITHOUT a position.
 *   3. strip      - `module.stripTypeScriptTypes` is the runtime authority
 *                   (node's own amaro-based stripper). When it rejects and
 *                   the TS pass explained nothing, its message is the report.
 *   4. runtime    - constructs that pass stripping yet fail when node executes
 *                   the stripped ESM output: decorators, CJS globals
 *                   (`require` / `__dirname` / ...), and dynamic imports with
 *                   disallowed or non-literal specifiers.
 *   5. eslint     - static import allowlist (`no-restricted-imports`: only
 *                   `node:*` and `#jobs-sdk`; shared literal with the repo
 *                   eslint config via `import-policy.ts`), with an isolated
 *                   config - the repository config is never consulted.
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

/**
 * Name rules (plan §5.4): module-file safe, traversal safe, bounded length,
 * and canonical (J-2 review F1): a registered name always passes; a user-only
 * name must be dot-free and must not alias a builtin's module file. Without
 * this, saving `jobs-prune` would overwrite the `jobs.prune` builtin's user
 * file as a plain "user" job - no fork sidecar, no upgrade baseline - and
 * `my.job` would silently live in `my-job.ts` under a different identity.
 */
export function checkJobName(name: string): GateError[] {
	const errors: GateError[] = [];
	// `new` is reserved by the admin route (/admin/maintenance/new): a job
	// with that name would shadow the create page and its edit link.
	if (name === 'new') {
		errors.push({
			source: 'name',
			line: null,
			column: null,
			message: 'job name "new" is reserved by the admin create route'
		});
	}
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
	} else if (!isCanonicalJobName(name)) {
		errors.push({
			source: 'name',
			line: null,
			column: null,
			message:
				'job name must be a registered builtin name, or a dot-free user name whose file mapping is its own ("my-task", not "my.job" or a builtin module alias)'
		});
	}
	return errors;
}

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

/**
 * Reported only when TypeScript explained nothing (see `runSaveGate`). The TS
 * 1xxx pass covered every rejection the stripper produced in probes (the TS
 * rule set is stricter), so this fallback arm is defensive and currently has
 * no input that exercises it - it is kept because node's stripper, not TS,
 * decides what actually runs.
 */
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
// Runtime residue: passes stripping, fails on execution
// ---------------------------------------------------------------------------

/**
 * CJS globals that `@types/node` declares globally but that do not exist in
 * the ESM job runtime (`$DATA_DIR/jobs/package.json` is `"type": "module"`):
 * referencing them is a guaranteed ReferenceError at run time, yet the TS
 * 1xxx pass does not flag them (they are legitimately declared globals for
 * the real type environment). One common source of false positives is
 * deliberate shadowing (`const require = createRequire(...)` or a function
 * parameter named like a global), so any file that binds the name itself is
 * exempted.
 */
const RESIDUE_GLOBALS = new Set(['require', '__dirname', '__filename', 'module', 'exports']);

function collectBoundNames(ts: TsModule, sourceFile: SourceFile): Set<string> {
	const bound = new Set<string>();
	const addBinding = (name: import('typescript').BindingName): void => {
		if (ts.isIdentifier(name)) bound.add(name.text);
		else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
			for (const element of name.elements) {
				if (ts.isBindingElement(element)) addBinding(element.name);
			}
		}
	};
	const visit = (node: TypeScriptNode): void => {
		if (ts.isVariableDeclaration(node)) addBinding(node.name);
		else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
			if (node.name) bound.add(node.name.text);
		} else if (ts.isParameter(node)) addBinding(node.name);
		else if (ts.isImportSpecifier(node) || ts.isImportClause(node)) {
			if (node.name) bound.add(node.name.text);
		} else if (ts.isCatchClause(node) && node.variableDeclaration) {
			addBinding(node.variableDeclaration.name);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return bound;
}

/**
 * Skip identifiers that are names, not references (property keys etc.).
 * Expanded by the J-2 review round 2 (D4): destructuring renames, interface /
 * class member names, labels and `typeof X` type queries are names or type
 * positions - flagging them rejected legitimate scripts.
 */
function isResidueReference(ts: TsModule, node: import('typescript').Identifier): boolean {
	const parent = node.parent;
	if (!parent) return false;
	// The call-expression arm owns `require(...)`; reporting its callee here
	// again double-reported the same site (J-2 review round 2, D4). Only
	// `require` is skipped - `exports('x')` in callee position is a real
	// runtime reference and stays flagged (round 3, P3-1).
	if (ts.isCallExpression(parent) && parent.expression === node && node.text === 'require') {
		return false;
	}
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
		// `globalThis.require` is the CJS global itself, not a property name
		// (the review's known miss); other `x.require` shapes stay skipped.
		return ts.isIdentifier(parent.expression) && parent.expression.text === 'globalThis';
	}
	if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
	if (ts.isPropertySignature(parent) && parent.name === node) return false;
	if (ts.isPropertyDeclaration(parent) && parent.name === node) return false;
	if (ts.isMethodSignature(parent) && parent.name === node) return false;
	if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
	if (ts.isGetAccessorDeclaration(parent) && parent.name === node) return false;
	if (ts.isSetAccessorDeclaration(parent) && parent.name === node) return false;
	if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
	if (ts.isLabeledStatement(parent) && parent.label === node) return false;
	if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)
		return false;
	if (ts.isTypeQueryNode(parent)) return false;
	if (ts.isQualifiedName(parent) && parent.right === node) return false;
	if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)) {
		return false;
	}
	if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
	if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) {
		return false;
	}
	return true;
}

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
	const bound = collectBoundNames(ts, sourceFile);
	const report = (node: TypeScriptNode, message: string): void => {
		const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
		errors.push({
			source: 'runtime',
			line: position.line + 1,
			column: position.character + 1,
			message
		});
	};
	const visit = (node: TypeScriptNode): void => {
		if (ts.canHaveDecorators(node)) {
			for (const decorator of ts.getDecorators(node) ?? []) {
				report(
					decorator,
					'decorators pass type stripping but are not valid JavaScript at run time (strip-only mode)'
				);
			}
		}
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'require' &&
			!bound.has('require')
		) {
			report(
				node.expression,
				'require(...) is not available in ESM job scripts; import a node:* module instead'
			);
		} else if (
			ts.isIdentifier(node) &&
			RESIDUE_GLOBALS.has(node.text) &&
			!bound.has(node.text) &&
			isResidueReference(ts, node)
		) {
			report(
				node,
				`${node.text} is not defined in ESM job scripts (the user layer runs as a module); use node:* imports instead`
			);
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const source = node.arguments[0];
			if (source && ts.isStringLiteralLike(source)) {
				if (!isAllowedImportSpecifier(source.text)) {
					report(
						source,
						`dynamically imported modules must be node:* or #jobs-sdk (got "${source.text}")`
					);
				}
			} else {
				report(
					node,
					'dynamic import specifiers must be string literals (node:* or #jobs-sdk); computed specifiers cannot be verified'
				);
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

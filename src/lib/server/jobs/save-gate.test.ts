import { describe, expect, it } from 'vitest';
import { checkJobName, runSaveGate } from './save-gate';

/**
 * Save-gate unit teeth (grill R2-1, plan T7 at unit level; the drain-side
 * end-to-end probes live in the verify harness). The three plan negatives -
 * enum / bad import specifier shapes / forbidden module - plus the probes
 * that shaped the pipeline: TS carries positions for strip-only rejections,
 * decorators are rejected as runtime residue, and node's stripper is only
 * reported when TypeScript explained nothing.
 */

const VALID = `import { getOption, type JobContext } from '#jobs-sdk';
import { readFile } from 'node:fs/promises';

export default {
	async run(ctx: JobContext): Promise<void> {
		await getOption('friends.checks', ctx.db);
		ctx.logger.info(String(readFile));
	}
};
`;

describe('checkJobName', () => {
	it('accepts registry-shaped names', () => {
		expect(checkJobName('my-task')).toEqual([]);
		expect(checkJobName('jobs.prune')).toEqual([]);
	});

	it('rejects traversal shapes, device names and long names', () => {
		expect(checkJobName('Bad')).not.toEqual([]);
		expect(checkJobName('con')).not.toEqual([]);
		expect(checkJobName('../evil')).not.toEqual([]);
		expect(checkJobName('a'.repeat(65))).not.toEqual([]);
	});
});

describe('runSaveGate', { timeout: 60_000 }, () => {
	it('passes a well-formed script (node:* + #jobs-sdk imports only)', async () => {
		const report = await runSaveGate({ name: 'my-task', code: VALID });
		expect(report.errors).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it('rejects an enum with the TS 1294 position (strip has no position)', async () => {
		const report = await runSaveGate({
			name: 'bad-enum',
			code: 'const a = 1;\n\nenum E { A }\n\nexport default { run() {} };\n'
		});
		expect(report.ok).toBe(false);
		const tsErrors = report.errors.filter((error) => error.source === 'typescript');
		expect(tsErrors).toHaveLength(1);
		expect(tsErrors[0]).toMatchObject({ code: 1294, line: 3, column: 6 });
		// No duplicate strip entry: TS explained the rejection with a position.
		expect(report.errors.filter((error) => error.source === 'strip')).toEqual([]);
	});

	it('rejects parameter properties and namespaces too', async () => {
		const param = await runSaveGate({
			name: 'bad-param',
			code: 'class C {\n\tconstructor(private x: number) {}\n}\nexport default { run() {} };\n'
		});
		expect(param.errors.some((error) => error.code === 1294 && error.line === 2)).toBe(true);
		const ns = await runSaveGate({
			name: 'bad-ns',
			code: 'namespace N { export const x = 1; }\nexport default { run() {} };\n'
		});
		expect(ns.errors.some((error) => error.code === 1294 && error.line === 1)).toBe(true);
	});

	it('reports plain syntax errors through TypeScript, not through strip', async () => {
		const report = await runSaveGate({ name: 'bad-syntax', code: 'const = ;\n' });
		expect(report.errors.some((error) => error.source === 'typescript')).toBe(true);
		expect(report.errors.filter((error) => error.source === 'strip')).toEqual([]);
		expect(report.ok).toBe(false);
	});

	it('rejects decorators as runtime residue even though stripping passes', async () => {
		const report = await runSaveGate({
			name: 'bad-decorator',
			code: 'const dec = (value: unknown) => value;\n@dec\nclass C {}\nexport default { run() {} };\n'
		});
		expect(report.ok).toBe(false);
		const runtime = report.errors.filter((error) => error.source === 'runtime');
		expect(runtime).toHaveLength(1);
		expect(runtime[0]).toMatchObject({ line: 2 });
		expect(runtime[0].message).toContain('decorator');
	});

	it('rejects forbidden imports with positions and lets allowed ones pass', async () => {
		const report = await runSaveGate({
			name: 'bad-imports',
			code:
				[
					"import fs from 'node:fs';",
					"import { getOption } from '#jobs-sdk';",
					"import zod from 'zod';",
					"import helper from './helper';"
				].join('\n') + '\n'
		});
		const lint = report.errors.filter((error) => error.source === 'eslint');
		expect(lint.map((error) => error.line)).toEqual([3, 4]);
		expect(lint.every((error) => error.code === 'no-restricted-imports')).toBe(true);
	});

	it('allows the one-slash node: builtins (node:fs/promises regression)', async () => {
		const report = await runSaveGate({
			name: 'node-slash',
			code: "import { readFile } from 'node:fs/promises';\nexport default { run() {} };\n"
		});
		expect(report.errors.filter((error) => error.source === 'eslint')).toEqual([]);
		expect(report.ok).toBe(true);
	});

	it('accumulates errors across sources in one report', async () => {
		const report = await runSaveGate({
			name: 'mixed',
			code: "import zod from 'zod';\nenum E { A }\nexport default { run() {} };\n"
		});
		const sources = new Set(report.errors.map((error) => error.source));
		expect(sources.has('typescript')).toBe(true);
		expect(sources.has('eslint')).toBe(true);
	});
});

describe('canonical name mapping (J-2 review F1)', { timeout: 60_000 }, () => {
	it('rejects names that would live under a different identity', () => {
		expect(checkJobName('my.job')).not.toEqual([]);
		expect(checkJobName('jobs-prune')).not.toEqual([]);
		expect(checkJobName('jobs.prune')).toEqual([]);
		expect(checkJobName('my-task')).toEqual([]);
		// The length boundary is inclusive (review round 2, P2-4): 65 fails,
		// 64 passes - an off-by-one here would silently move the limit.
		expect(checkJobName('a'.repeat(64))).toEqual([]);
	});

	it('runSaveGate reports the name error itself', async () => {
		const report = await runSaveGate({ name: 'my.job', code: VALID });
		expect(report.ok).toBe(false);
		expect(report.errors.some((error) => error.source === 'name')).toBe(true);
	});
});

describe('dynamic imports and CJS residue (J-2 review F3/F6)', { timeout: 60_000 }, () => {
	it('rejects dynamic imports outside the allowlist, with a position', async () => {
		const report = await runSaveGate({
			name: 'dyn-bad',
			code: "const m = await import('lodash');\nexport default { run() { return m; } };\n"
		});
		const runtime = report.errors.filter((error) => error.source === 'runtime');
		expect(runtime.some((error) => error.line === 1)).toBe(true);
		expect(runtime.some((error) => error.message.includes('node:*'))).toBe(true);
	});

	it('rejects computed dynamic specifiers and accepts node:* ones', async () => {
		const computed = await runSaveGate({
			name: 'dyn-computed',
			code: "const which = 'node:fs';\nconst m = await import(which);\nexport default { run() { return m; } };\n"
		});
		expect(computed.errors.some((error) => error.source === 'runtime' && error.line === 2)).toBe(
			true
		);
		const allowed = await runSaveGate({
			name: 'dyn-ok',
			code: "const m = await import('node:fs/promises');\nexport default { run() { return m; } };\n"
		});
		expect(allowed.ok).toBe(true);
	});

	it('rejects CJS globals that fail at run time in the ESM user layer', async () => {
		const report = await runSaveGate({
			name: 'cjs-residue',
			code: "const fs = require('node:fs');\nmodule.exports = { run() { return fs; } };\n"
		});
		const runtime = report.errors.filter((error) => error.source === 'runtime');
		expect(runtime.some((error) => error.message.includes('require'))).toBe(true);
		expect(runtime.some((error) => error.message.includes('module'))).toBe(true);
	});

	it('exempts files that shadow the names themselves', async () => {
		const report = await runSaveGate({
			name: 'shadowed',
			code: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport default { run() { return require; } };\n"
		});
		expect(report.errors.filter((error) => error.source === 'runtime')).toEqual([]);
	});

	it('rejects substring lookalikes of the SDK specifier (review round 2, D3)', async () => {
		const report = await runSaveGate({
			name: 'evil-substr',
			code: "import z from 'evil#jobs-sdk';\nimport y from '#jobs-sdk/x';\nexport default { run() {} };\n"
		});
		const lint = report.errors.filter((error) => error.source === 'eslint');
		expect(lint.map((error) => error.line)).toEqual([1, 2]);
	});

	it('flags exactly the CJS residue sites, not names or type positions (review round 2, D4)', async () => {
		const clean = await runSaveGate({
			name: 'residue-names',
			code: [
				'const src = { module: 1, exports: 2 };',
				'const { module: m, exports: e } = src;',
				'type Cfg = { require?: boolean };',
				'type T = typeof require;',
				'class Box { module = 1; }',
				'require: for (let i = 0; i < 1; i++) { break require; }',
				"export default { run() { return [m, e, new Box(), 'Cfg' as unknown as Cfg, undefined as unknown as T]; } };",
				''
			].join('\n')
		});
		expect(clean.errors.filter((error) => error.source === 'runtime')).toEqual([]);

		const calls = await runSaveGate({
			name: 'residue-calls',
			code: "const fs = require('node:fs');\nmodule.exports = { run() { return fs; } };\n"
		});
		const runtime = calls.errors.filter((error) => error.source === 'runtime');
		// Exactly two: the require(...) call once (no callee double-report) and
		// the `module` reference; `exports` is a property name.
		expect(runtime).toHaveLength(2);
		expect(runtime.some((error) => error.message.includes('require'))).toBe(true);
		expect(runtime.some((error) => error.message.includes('module'))).toBe(true);

		const globalRequire = await runSaveGate({
			name: 'residue-global',
			code: "const fs = globalThis.require('node:fs');\nexport default { run() { return fs; } };\n"
		});
		expect(
			globalRequire.errors.some(
				(error) => error.source === 'runtime' && error.message.includes('require')
			)
		).toBe(true);
	});
});

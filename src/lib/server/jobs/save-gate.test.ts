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

describe('runSaveGate', { timeout: 30_000 }, () => {
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

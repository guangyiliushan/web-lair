import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/**
 * A2 static guard: the admin surface (routes, admin components, auth pages)
 * and the markdown editor family must not carry hardcoded Chinese (or CJK
 * full-width punctuation) outside comments.
 *
 * The allowlist below stays EMPTY by design - test fixtures are exempted by
 * path (they assert catalog copy or carry fixture content), so any remaining
 * hit is a real violation. Adding an entry requires a one-line rationale in
 * the A2 fix batch (see the plan's section A2 acceptance notes).
 *
 * Known blind spots (registered, currently zero instances): CJK escape
 * sequences (`\uXXXX` / HTML entities), extension-B ideographs (U+20000+),
 * a literal `//` inside a string swallowing its line tail, and single-locale
 * label maps (plain ASCII strings that render Chinese - the guard cannot see
 * those; treat label maps as locale-resolved by construction).
 */

const ROOTS = [
	'src/routes/(admin)',
	'src/lib/components/admin',
	'src/lib/components/markdown',
	'src/routes/(admin-auth)'
] as const;

/** Per-root sanity floors (a silently broken walker must fail loud). */
const ROOT_FLOORS: Record<(typeof ROOTS)[number], number> = {
	'src/routes/(admin)': 50,
	'src/lib/components/admin': 10,
	'src/lib/components/markdown': 60,
	'src/routes/(admin-auth)': 4
};

const EXEMPT_SUFFIXES = ['.test.ts', '.spec.ts'] as const;
const EXEMPT_SEGMENTS = ['/testing/'] as const;

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

// Comment strippers: HTML comments, Svelte comments, block comments, and line
// comments (URL schemes `://` protected by the lookbehind).
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SVELTE_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(?<!:)\/\/[^\n]*/g;

/** Strip the four comment forms (exported for the seeded unit tests). */
export function stripComments(text: string): string {
	return text
		.replace(HTML_COMMENT, '')
		.replace(SVELTE_COMMENT, '')
		.replace(BLOCK_COMMENT, '')
		.replace(LINE_COMMENT, '');
}

/** Line-level CJK detector over comment-stripped text (pure, unit-tested). */
export function findViolationLines(text: string): number[] {
	const out: number[] = [];
	stripComments(text)
		.split('\n')
		.forEach((line, index) => {
			if (CJK.test(line)) out.push(index + 1);
		});
	return out;
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walk(path));
		} else if (entry.name.endsWith('.svelte') || entry.name.endsWith('.ts')) {
			out.push(path);
		}
	}
	return out;
}

function isExempt(path: string): boolean {
	const posix = path.replaceAll('\\', '/');
	if (EXEMPT_SUFFIXES.some((suffix) => posix.endsWith(suffix))) return true;
	return EXEMPT_SEGMENTS.some((segment) => posix.includes(segment));
}

/** Empty by design — see the header comment. */
const ALLOWLIST: ReadonlyArray<{ file: string; needle: string }> = [];

function scanRoots(roots: readonly string[]): { files: string[]; violations: string[] } {
	const files: string[] = [];
	const violations: string[] = [];
	for (const root of roots) {
		for (const path of walk(root)) {
			if (isExempt(path)) continue;
			files.push(path);
			const rel = relative(process.cwd(), path);
			const text = readFileSync(path, 'utf-8');
			for (const lineNumber of findViolationLines(text)) {
				const line = text.split('\n')[lineNumber - 1] ?? '';
				const allowed = ALLOWLIST.some(
					(entry) => rel === entry.file && line.includes(entry.needle)
				);
				if (!allowed) violations.push(`${rel}:${lineNumber}: ${line.trim()}`);
			}
		}
	}
	return { files, violations };
}

describe('admin i18n static guard (A2)', () => {
	describe('detector self-tests (seeded)', () => {
		it('flags hardcoded CJK in code, including full-width punctuation', () => {
			expect(findViolationLines("const x = '中文';")).toEqual([1]);
			expect(findViolationLines('<p>删掉，请。</p>')).toEqual([1]);
		});

		it('never flags the four comment forms, and URL lines stay code', () => {
			expect(findViolationLines('// 注释\n/* 块注释 */\n<!-- HTML -->\n{/* svelte */}')).toEqual(
				[]
			);
			expect(findViolationLines("const u = 'https://例.com/x';")).toEqual([1]);
			expect(findViolationLines("// see https://例.com/a - 'x'")).toEqual([]);
		});

		it('walker catches a seeded violation in a temp tree', () => {
			const dir = mkdtempSync(join(tmpdir(), 'admin-i18n-guard-'));
			try {
				writeFileSync(join(dir, 'seed.svelte'), '<p>违例</p>\n');
				const { violations } = scanRoots([dir]);
				expect(violations.some((v) => v.includes('seed.svelte'))).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	describe('live tree', () => {
		const { files, violations } = scanRoots(ROOTS);

		it('scans the full surface (per-root sanity floors)', () => {
			for (const root of ROOTS) {
				const count = files.filter((f) => f.replaceAll('\\', '/').startsWith(root)).length;
				expect(count, `root ${root} scanned ${count} files`).toBeGreaterThanOrEqual(
					ROOT_FLOORS[root]
				);
			}
		});

		it('has no hardcoded CJK outside comments, with an empty allowlist', () => {
			expect(ALLOWLIST.length).toBe(0);
			expect(violations).toEqual([]);
		});
	});
});

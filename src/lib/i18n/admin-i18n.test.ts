import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A2 static guard: the admin surface and the markdown editor family must not
 * carry hardcoded Chinese (or CJK full-width punctuation) outside comments.
 *
 * The allowlist below stays EMPTY by design — test fixtures are exempted by
 * path (they assert catalog copy or carry fixture content), so any remaining
 * hit is a real violation. Adding an entry requires a one-line rationale in
 * the A2 fix batch (plan §A2 验收).
 */

const ROOTS = [
	'src/routes/(admin)',
	'src/lib/components/admin',
	'src/lib/components/markdown'
] as const;

const EXEMPT_SUFFIXES = ['.test.ts', '.spec.ts'] as const;
const EXEMPT_SEGMENTS = ['/testing/'] as const;

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

// Comment strippers, mirroring the A2 rescan tooling: HTML comments, Svelte
// comments, block comments, and line comments (URL schemes `://` protected).
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const SVELTE_COMMENT = /\{\/\*[\s\S]*?\*\/\}/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(?<!:)\/\/[^\n]*/g;

function stripComments(text: string): string {
	return text
		.replace(HTML_COMMENT, '')
		.replace(SVELTE_COMMENT, '')
		.replace(BLOCK_COMMENT, '')
		.replace(LINE_COMMENT, '');
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

function scan(): { files: string[]; violations: string[] } {
	const files: string[] = [];
	const violations: string[] = [];
	for (const root of ROOTS) {
		for (const path of walk(root)) {
			if (isExempt(path)) continue;
			files.push(path);
			const stripped = stripComments(readFileSync(path, 'utf-8'));
			const rel = relative(process.cwd(), path);
			stripped.split('\n').forEach((line, index) => {
				if (!CJK.test(line)) return;
				const allowed = ALLOWLIST.some(
					(entry) => rel === entry.file && line.includes(entry.needle)
				);
				if (!allowed) violations.push(`${rel}:${index + 1}: ${line.trim()}`);
			});
		}
	}
	return { files, violations };
}

describe('admin i18n static guard (A2)', () => {
	const { files, violations } = scan();

	it('scans the full surface (walker sanity check)', () => {
		// guards against a silently broken walker: the A2 surface is 80+ files.
		expect(files.length).toBeGreaterThan(80);
	});

	it('has no hardcoded CJK outside comments, and an empty allowlist', () => {
		expect(ALLOWLIST.length).toBe(0);
		expect(violations).toEqual([]);
	});
});

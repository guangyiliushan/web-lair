import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __unstable__loadDesignSystem } from '@tailwindcss/node';
import { parse } from 'svelte/compiler';

/**
 * Project-wide equivalent of the Tailwind CSS IntelliSense rule
 * `tailwindCSS.lint.suggestCanonicalClasses` (the extension only reports on documents open in the editor):
 * this walks `src/` and asks the design system `@tailwindcss/vite` compiles from (`src/routes/layout.css`)
 * whether a class could be written more canonically.
 * Sources: `class` attributes (incl. `{…}` expressions and template literals), `class:list`, `@apply` in
 * `.css` and `<style>` (comments skipped), plus the class-list helpers in `CLASS_HELPERS`; `className` /
 * `ngClass` are left out (Svelte-only codebase, they would only be props).
 * Run: `pnpm ops dev lint-tw` reports only (exit 1 when something is off); `pnpm ops dev lint-tw --fix` rewrites the
 * offending class lists in place.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const entryCss = join(root, 'src', 'routes', 'layout.css');
const scanRoot = join(root, 'src');

/** Attributes whose value is a class list, and helper calls taking class lists. */
const CLASS_HELPERS = new Set(['cn', 'clsx', 'tv', 'cva', 'twMerge']);

const TOKEN = /\S+/g;

/** `@apply` value up to the terminating `;` / `}`, minus a trailing `!important`. */
const APPLY = /@apply\s+([^;}]+)/g;

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

const CUSTOM_PROPERTY = /(--[\w-]+)\s*:\s*([^;}]+)/g;

const VAR_REFERENCE = /var\(\s*(--[\w-]+)/g;

type AstNode = { type: string; [key: string]: unknown };

type ClassList = { start: number; end: number; text: string };

type Finding = {
	file: string;
	start: number;
	end: number;
	line: number;
	column: number;
	from: string;
	to: string;
};

function isNode(value: unknown): value is AstNode {
	return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

function walk(node: unknown, visit: (node: AstNode) => void): void {
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (!isNode(node)) return;
	visit(node);
	for (const [key, value] of Object.entries(node)) {
		if (key === 'loc' || key === 'metadata' || key === 'parent') continue;
		walk(value, visit);
	}
}

function isClassHelper(callee: unknown): boolean {
	return isNode(callee) && callee.type === 'Identifier' && CLASS_HELPERS.has(String(callee.name));
}

/**
 * Every string this file treats as a class list. Spans are slice-verified
 * against the source before they are used, so anything the AST nests in a way
 * `start`/`end` do not describe is skipped instead of rewritten.
 */
function collectClassLists(source: string, ast: unknown): ClassList[] {
	const spans = new Map<string, ClassList>();

	const add = (start: unknown, end: unknown, text: string) => {
		if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return;
		if (source.slice(start, end) !== text) return;
		spans.set(`${start}:${end}`, { start, end, text });
	};

	const addStrings = (node: unknown) => {
		walk(node, (child) => {
			const { start, end } = child;
			if (typeof start !== 'number' || typeof end !== 'number') return;
			if (child.type === 'Literal' && typeof child.value === 'string') {
				add(start + 1, end - 1, child.value);
			} else if (child.type === 'TemplateElement') {
				const raw = (child.value as { raw?: unknown } | undefined)?.raw;
				if (typeof raw === 'string') add(start, end, raw);
			}
		});
	};

	walk(ast, (node) => {
		if (node.type === 'Attribute' && node.name === 'class') {
			if (!Array.isArray(node.value)) return;
			for (const part of node.value) {
				if (!isNode(part)) continue;
				if (part.type === 'Text') add(part.start, part.end, String(part.data ?? ''));
				else if (part.type === 'ExpressionTag') addStrings(part.expression);
			}
		} else if (node.type === 'ClassDirective' && node.name === 'list') {
			addStrings(node.expression);
		} else if (node.type === 'CallExpression' && isClassHelper(node.callee)) {
			addStrings(node.arguments);
		}
	});

	return [...spans.values()];
}

/** `@apply` class lists in a CSS fragment; comments are blanked out first so a
 * comment that merely mentions `@apply` cannot swallow the statement after it. */
function collectApplyLists(css: string, base: number): ClassList[] {
	const masked = css.replace(CSS_COMMENT, (comment) => ' '.repeat(comment.length));

	const lists: ClassList[] = [];
	for (const match of masked.matchAll(APPLY)) {
		const text = match[1].replace(/\s*!important\s*$/, '');
		const start = base + match.index + match[0].length - match[1].length;
		lists.push({ start, end: start + text.length, text });
	}
	return lists;
}

/** Inner CSS of a `<style>` block, with the offset its contents start at. */
function styleBlockOf(ast: unknown): { start: number; styles: string } | null {
	if (!isNode(ast) || !isNode(ast.css)) return null;
	const content = ast.css.content;
	if (content === null || typeof content !== 'object') return null;
	const { start, styles } = content as { start?: unknown; styles?: unknown };
	if (typeof start !== 'number' || typeof styles !== 'string') return null;
	return { start, styles };
}

/** Everything except `@theme` blocks, so only plain-CSS custom properties remain. */
function withoutThemeBlocks(css: string): string {
	const masked = css.replace(CSS_COMMENT, (comment) => ' '.repeat(comment.length));
	const chars = masked.split('');
	let from = 0;
	for (;;) {
		const at = masked.indexOf('@theme', from);
		if (at === -1) break;
		const open = masked.indexOf('{', at);
		if (open === -1) break;
		let depth = 0;
		let end = open;
		for (; end < masked.length; end++) {
			if (masked[end] === '{') depth += 1;
			else if (masked[end] === '}' && --depth === 0) break;
		}
		for (let i = at; i <= end && i < masked.length; i++) chars[i] = ' ';
		from = end + 1;
	}
	return chars.join('');
}

function lineStartsOf(source: string): number[] {
	const starts = [0];
	for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
	return starts;
}

function locate(starts: number[], offset: number): { line: number; column: number } {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid] <= offset) low = mid;
		else high = mid - 1;
	}
	return { line: low + 1, column: offset - starts[low] + 1 };
}

function displayPath(file: string): string {
	return relative(root, file).split(sep).join('/');
}

/** The parser drops a leading BOM, so offsets are only valid against the stripped text. */
function splitBom(text: string): { source: string; bom: string } {
	const bom = text.charCodeAt(0) === 0xfeff ? text[0] : '';
	return { source: bom ? text.slice(1) : text, bom };
}

async function scanFiles(dir: string): Promise<string[]> {
	const found: string[] = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await scanFiles(path)));
		else if (entry.isFile() && /\.(svelte|css)$/.test(entry.name)) found.push(path);
	}
	return found.sort();
}

function applyEdits(source: string, edits: Finding[]): string {
	let out = source;
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
		out = out.slice(0, edit.start) + edit.to + out.slice(edit.end);
	}
	return out;
}

const fix = process.argv.includes('--fix');

const designSystem = await __unstable__loadDesignSystem(await readFile(entryCss, 'utf8'), {
	base: root
});

const canonicalCache = new Map<string, string>();

function canonicalForm(candidate: string): string {
	let canonical = canonicalCache.get(candidate);
	if (canonical === undefined) {
		canonical = designSystem.canonicalizeCandidates([candidate], { rem: 16 })[0] ?? candidate;
		canonicalCache.set(candidate, canonical);
	}
	return canonical;
}

const files = await scanFiles(scanRoot);
const sources = new Map<string, { source: string; bom: string }>();
for (const file of files) sources.set(file, splitBom(await readFile(file, 'utf8')));

/**
 * `@theme` is not the only place custom properties get set: a value redefined
 * in plain CSS (e.g. `:root { --radius: 0.625rem }`) wins over the theme at
 * runtime, so the design system compiles against a value the browser never
 * sees. Rewrites that resolve through such a property cannot be verified, so
 * they are reported instead of applied.
 */
const runtimeProperties = new Map<string, string>();
for (const [file, { source }] of sources) {
	if (!file.endsWith('.css')) continue;
	for (const match of withoutThemeBlocks(source).matchAll(CUSTOM_PROPERTY)) {
		if (!runtimeProperties.has(match[1])) runtimeProperties.set(match[1], match[2].trim());
	}
}

const overriddenThemeValues = new Set(
	[...runtimeProperties]
		.filter(([name, value]) => {
			const themed = designSystem.resolveThemeValue(name);
			return typeof themed === 'string' && themed.trim() !== value;
		})
		.map(([name]) => name)
);

function dependsOnOverriddenTheme(css: string): boolean {
	const pending = [...css.matchAll(VAR_REFERENCE)].map((match) => match[1]);
	const seen = new Set<string>();
	while (pending.length > 0) {
		const name = pending.pop() as string;
		if (seen.has(name)) continue;
		seen.add(name);
		if (overriddenThemeValues.has(name)) return true;
		const themed = designSystem.resolveThemeValue(name);
		if (typeof themed === 'string') {
			for (const match of themed.matchAll(VAR_REFERENCE)) pending.push(match[1]);
		}
	}
	return false;
}

type Skipped = { file: string; line: number; column: number; from: string; to: string };

const findings: Finding[] = [];
const skipped: Skipped[] = [];

for (const file of files) {
	const stored = sources.get(file);
	if (!stored) continue;
	const { source } = stored;
	let lists: ClassList[];

	if (file.endsWith('.css')) {
		lists = collectApplyLists(source, 0);
	} else {
		let ast: unknown;
		try {
			ast = parse(source, { modern: true });
		} catch (error) {
			console.error(`✗ ${displayPath(file)}: ${(error as Error).message}`);
			process.exitCode = 1;
			continue;
		}
		lists = collectClassLists(source, ast);
		const style = styleBlockOf(ast);
		if (style) lists.push(...collectApplyLists(style.styles, style.start));
	}

	const starts = lineStartsOf(source);
	for (const list of lists) {
		for (const match of list.text.matchAll(TOKEN)) {
			const from = match[0];
			const to = canonicalForm(from);
			if (to === from) continue;
			const start = list.start + match.index;

			if (dependsOnOverriddenTheme(designSystem.candidatesToCss([to])[0] ?? '')) {
				skipped.push({ file, ...locate(starts, start), from, to });
				continue;
			}

			findings.push({
				file,
				start,
				end: start + from.length,
				...locate(starts, start),
				from,
				to
			});
		}
	}
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
skipped.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

for (const item of skipped) {
	console.log(
		`${displayPath(item.file)}:${item.line}:${item.column}  ${item.from} → ${item.to}  (left alone: theme value overridden outside @theme)`
	);
}

if (findings.length === 0) {
	console.log(`✓ ${files.length} files scanned — nothing to rewrite`);
} else if (fix) {
	const byFile = new Map<string, Finding[]>();
	for (const finding of findings) {
		const list = byFile.get(finding.file) ?? [];
		list.push(finding);
		byFile.set(finding.file, list);
	}
	for (const [file, edits] of byFile) {
		const { source, bom } = splitBom(await readFile(file, 'utf8'));
		await writeFile(file, bom + applyEdits(source, edits), 'utf8');
	}
	console.log(
		`✓ rewrote ${findings.length} class names in ${byFile.size} files (${files.length} scanned)`
	);
} else {
	for (const finding of findings) {
		console.log(
			`${displayPath(finding.file)}:${finding.line}:${finding.column}  ${finding.from} → ${finding.to}`
		);
	}
	console.log(
		`\n✗ ${findings.length} non-canonical class names in ${new Set(findings.map((f) => f.file)).size} of ${files.length} files — run \`pnpm ops dev lint-tw --fix\` to rewrite them`
	);
	process.exitCode = 1;
}

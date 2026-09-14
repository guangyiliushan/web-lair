import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Guard over the paraglide message contract. These tests scan the repo state
 * so that a missing key fails here instead of crashing rendering at runtime
 * (`m.some_key is not a function`) or rendering an "undefined" placeholder.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MESSAGES_DIR = join(ROOT, 'messages');
const PARAGLIDE_OUT = join(ROOT, 'src', 'lib', 'paraglide');
const SELF = fileURLToPath(import.meta.url);
const SOURCE_EXTENSIONS = ['.svelte', '.ts', '.js'];
const SKIP_DIRS = new Set(['node_modules', '.svelte-kit']);

// A local `m` binding shadows the paraglide import and regex scanning cannot
// tell the two apart, so such files are excluded from key checks (svelte-check
// still type-checks their m.* calls against the compiled output).
const SHADOWED_M_PATTERN = /\b(?:const|let|var|function)\s+m\b|\bimport[\s\S]*?\bas\s+m\b/;

const settings = JSON.parse(
	readFileSync(join(ROOT, 'project.inlang', 'settings.json'), 'utf8')
) as {
	baseLocale: string;
	locales: string[];
};
const LOCALES = settings.locales;
const BASE_LOCALE = settings.baseLocale;

function readLocaleMessages(locale: string): Record<string, string> {
	return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8'));
}

function* walkSources(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			// Generated output: its JSDoc examples call m.hello() and other keys
			// that intentionally do not exist in this project's messages.
			if (fullPath === PARAGLIDE_OUT) continue;
			if (!SKIP_DIRS.has(entry)) yield* walkSources(fullPath);
		} else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
			if (fullPath !== SELF) yield fullPath;
		}
	}
}

interface Usage {
	key: string;
	site: string;
	/** Source text of the call's argument list, when the usage is a call. */
	args?: string;
}

// `\bm\.` only matches the paraglide `m` import: the codebase has no other `m` binding.
const REFERENCE_PATTERN = /\bm\.([A-Za-z_$][\w$]*)/g;
const CALL_ARGUMENTS_PATTERN = /\s*\(/;

/** Walks from just after `(` to its matching `)`, skipping string literals. */
function extractCallArgs(source: string, openParenIndex: number): string {
	let depth = 1;
	let i = openParenIndex + 1;
	while (i < source.length && depth > 0) {
		const char = source[i];
		if (char === "'" || char === '"' || char === '`') {
			const quote = char;
			i++;
			while (i < source.length && source[i] !== quote) {
				if (source[i] === '\\') i++;
				i++;
			}
		} else if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth--;
		}
		i++;
	}
	return source.slice(openParenIndex + 1, i - 1);
}

function collectUsages(): Usage[] {
	const usages: Usage[] = [];
	for (const filePath of walkSources(join(ROOT, 'src'))) {
		const source = readFileSync(filePath, 'utf8');
		if (SHADOWED_M_PATTERN.test(source)) continue;
		const lineAt = (index: number) => source.slice(0, index).split('\n').length;
		for (const match of source.matchAll(REFERENCE_PATTERN)) {
			const index = match.index;
			if (index === undefined) continue;
			const rest = source.slice(index + match[0].length);
			const isCall = CALL_ARGUMENTS_PATTERN.test(rest);
			const usage: Usage = {
				key: match[1],
				site: `${filePath}:${lineAt(index)}`
			};
			if (isCall) {
				const openParenLength = rest.match(CALL_ARGUMENTS_PATTERN)?.[0].length ?? 0;
				const openParen = index + match[0].length + openParenLength;
				usage.args = extractCallArgs(source, openParen - 1);
			}
			usages.push(usage);
		}
	}
	return usages;
}

/** Placeholders like `{count}` that the compiled message reads from its inputs. */
function requiredPlaceholders(message: string): string[] {
	return [...message.matchAll(/\{\s*(\w+)\s*\}/g)].map((match) => match[1]);
}

/**
 * Identifiers provided in the call's first object literal. Extra identifiers
 * from nested expressions are harmless: the check only requires that every
 * placeholder name is present.
 */
function providedInputKeys(args: string | undefined): string[] | undefined {
	const trimmed = args?.trim() ?? '';
	if (!trimmed.startsWith('{')) return undefined;
	let depth = 0;
	let end = -1;
	for (let i = 0; i < trimmed.length; i++) {
		if (trimmed[i] === '{') depth++;
		else if (trimmed[i] === '}') {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return undefined;
	return [...trimmed.slice(1, end).matchAll(/(\w+)\s*(?::|,|\})/g)].map((match) => match[1]);
}

describe('paraglide message contract', () => {
	it('only accesses messages through static m.key() calls', () => {
		// Bracket access (m["nav.home"], m[key]) is valid paraglide but invisible
		// to the key scanner; fail here so the scanner gets extended instead of
		// silently missing usages.
		const dynamic: string[] = [];
		for (const filePath of walkSources(join(ROOT, 'src'))) {
			const source = readFileSync(filePath, 'utf8');
			if (SHADOWED_M_PATTERN.test(source)) continue;
			for (const match of source.matchAll(/\bm\s*\[/g)) {
				const index = match.index;
				if (index === undefined) continue;
				dynamic.push(`${filePath}:${source.slice(0, index).split('\n').length}`);
			}
		}
		expect(dynamic).toEqual([]);
	});

	it('resolves every m.* usage in src to a key defined in every locale file', () => {
		const localeMessages = Object.fromEntries(
			LOCALES.map((locale) => [locale, readLocaleMessages(locale)])
		);
		const usages = collectUsages();
		expect(usages.length).toBeGreaterThan(0);

		const missing: string[] = [];
		for (const usage of usages) {
			for (const locale of LOCALES) {
				if (!(usage.key in localeMessages[locale])) {
					missing.push(`${usage.key} @ ${usage.site} has no "${locale}" entry`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it('exports every used key from the compiled output, so m.key() cannot be undefined at runtime', () => {
		const usages = collectUsages();
		const usedKeys = [...new Set(usages.map((usage) => usage.key))];
		expect(usedKeys.length).toBeGreaterThan(0);

		const compiledFiles = [join(PARAGLIDE_OUT, 'messages', '_index.js')].concat(
			LOCALES.map((locale) => join(PARAGLIDE_OUT, 'messages', `${locale}.js`))
		);
		const stale: string[] = [];
		for (const file of compiledFiles) {
			const compiled = readFileSync(file, 'utf8');
			for (const key of usedKeys) {
				if (!compiled.includes(`export const ${key} `)) {
					stale.push(
						`${key} missing from ${file} — run: npx paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide`
					);
				}
			}
		}
		expect(stale).toEqual([]);
	});

	it('defines an identical key set in every locale file', () => {
		const baseKeys = Object.keys(readLocaleMessages(BASE_LOCALE)).sort();
		expect(baseKeys.length).toBeGreaterThan(0);
		for (const locale of LOCALES) {
			const keys = Object.keys(readLocaleMessages(locale)).sort();
			expect(keys, `${locale}.json diverges from ${BASE_LOCALE}.json`).toEqual(baseKeys);
		}
	});

	it('has a non-empty translation for every key in every locale', () => {
		const empty: string[] = [];
		for (const locale of LOCALES) {
			for (const [key, value] of Object.entries(readLocaleMessages(locale))) {
				if (typeof value !== 'string' || value.trim() === '') {
					empty.push(
						`${locale}.json:${key} is ${typeof value === 'string' ? 'empty' : typeof value}`
					);
				}
			}
		}
		expect(empty).toEqual([]);
	});

	it('passes every message placeholder at call sites that use a literal inputs object', () => {
		const baseMessages = readLocaleMessages(BASE_LOCALE);
		const usages = collectUsages();
		const violations: string[] = [];
		for (const usage of usages) {
			const message = baseMessages[usage.key];
			if (typeof message !== 'string') continue;
			const required = requiredPlaceholders(message);
			if (required.length === 0 || usage.args === undefined) continue;
			const provided = providedInputKeys(usage.args);
			if (provided === undefined) continue; // dynamic inputs cannot be checked statically
			for (const name of required) {
				if (!provided.includes(name)) {
					violations.push(`${usage.key} needs {${name}} but the call @ ${usage.site} passes none`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it('never embeds m.* calls as literal text in Svelte template strings', () => {
		// `title={`{m.bold()} (⌘B)`}` (missing $) ships the source code to the
		// user's tooltip. `{` directly after a backtick or quote is always such a
		// bug; `title={m.bold()}` and `${m.bold()}` are the correct forms.
		const literal: string[] = [];
		const pattern = /(?<=`)\{m\.[a-z_]+\(\)|(?<=['"])\{m\.[a-z_]+\(\)/g;
		for (const filePath of walkSources(join(ROOT, 'src'))) {
			if (!filePath.endsWith('.svelte')) continue;
			const source = readFileSync(filePath, 'utf8');
			for (const match of source.matchAll(pattern)) {
				const index = match.index;
				if (index === undefined) continue;
				literal.push(`${filePath}:${source.slice(0, index).split('\n').length}`);
			}
		}
		expect(literal).toEqual([]);
	});
});

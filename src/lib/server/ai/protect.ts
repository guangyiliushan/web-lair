/**
 * Markdown protection for machine translation.
 *
 * A prompt alone cannot guarantee that a model leaves code, URLs, image keys
 * or mentions untouched. This module replaces those spans with opaque tokens
 * before the call and restores them afterwards; any missing/duplicated token
 * fails the candidate instead of publishing a corrupted body.
 *
 * HTML's `translate="no"` attribute is still applied by the renderer as
 * defence in depth, but MDN documents that it is advisory ("not all browsers
 * recognize this attribute"), so it is not part of this guarantee.
 */

export interface ProtectedMarkdown {
	text: string;
	tokens: string[];
	prefix: string;
}

interface Token {
	value: string;
}

function fenceAt(line: string): { char: string; length: number } | null {
	const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
	if (!match) return null;
	return { char: match[1][0], length: match[1].length };
}

/**
 * Split out fenced code blocks first (line based, so nested backticks inside a
 * fence never confuse the inline-code pass). Returns the text with each block
 * replaced by a token plus the token values in document order.
 */
function protectFences(source: string): { text: string; tokens: Token[] } {
	const lines = source.split('\n');
	const out: string[] = [];
	const tokens: Token[] = [];
	for (let i = 0; i < lines.length; i++) {
		const open = fenceAt(lines[i]);
		if (!open) {
			out.push(lines[i]);
			continue;
		}
		let end = -1;
		for (let j = i + 1; j < lines.length; j++) {
			const close = fenceAt(lines[j]);
			if (close && close.char === open.char && close.length >= open.length) {
				end = j;
				break;
			}
		}
		if (end === -1) {
			// Unclosed fence: protect the rest of the document. This is safer
			// than letting the model rewrite code that the renderer still sees
			// as a fence.
			const block = lines.slice(i).join('\n');
			tokens.push({ value: block });
			out.push(`\u0000${tokens.length - 1}\u0000`);
			break;
		}
		const block = lines.slice(i, end + 1).join('\n');
		tokens.push({ value: block });
		out.push(`\u0000${tokens.length - 1}\u0000`);
		i = end;
	}
	return { text: out.join('\n'), tokens };
}

/** Inline code spans, preserving the exact backtick run length. */
function protectInlineCode(source: string, tokens: Token[]): string {
	return source.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (match) => {
		tokens.push({ value: match });
		return `\u0000${tokens.length - 1}\u0000`;
	});
}

/** Absolute URLs (including trailing markdown punctuation stripped). */
function protectUrls(source: string, tokens: Token[]): string {
	return source.replace(/https?:\/\/[^\s<>()[\]{}]+/g, (match) => {
		let url = match;
		let suffix = '';
		while (/[.,;:!?]$/.test(url)) {
			suffix = url.slice(-1) + suffix;
			url = url.slice(0, -1);
		}
		tokens.push({ value: url });
		return `\u0000${tokens.length - 1}\u0000${suffix}`;
	});
}

/** Relative link/image destinations inside `](...)` (may be paths, not URLs). */
function protectLinkTargets(source: string, tokens: Token[]): string {
	return source.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (match, target: string, title = '') => {
		if (target.includes('\u0000')) return match;
		tokens.push({ value: target });
		return `](\u0000${tokens.length - 1}\u0000${title})`;
	});
}

/** Mentions (`@gh:user`) and directive lines (`:::tabs …`). */
function protectStructuredSpans(source: string, tokens: Token[]): string {
	let text = source.replace(
		/(^|\n)([ \t]*:::.*)(?=\n|$)/g,
		(_match, lead: string, line: string) => {
			tokens.push({ value: line });
			return `${lead}\u0000${tokens.length - 1}\u0000`;
		}
	);
	text = text.replace(/@[a-z][a-z0-9_-]*:[A-Za-z0-9_.-]+/g, (match) => {
		tokens.push({ value: match });
		return `\u0000${tokens.length - 1}\u0000`;
	});
	return text;
}

function placeholderPrefix(source: string): string {
	let prefix = '[[WL';
	let n = 0;
	while (source.includes(prefix)) {
		n += 1;
		prefix = `[[WL${n}_`;
	}
	return prefix;
}

const NUL = String.fromCharCode(0);
const NUL_MARKER = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');

/**
 * Replace protected spans with `[[WL0]]`-style placeholders. The returned
 * tokens are the original snippets in document order.
 */
export function protectMarkdown(source: string): ProtectedMarkdown {
	const prefix = placeholderPrefix(source);
	const first = protectFences(source);
	const tokens = first.tokens;
	let text = first.text;
	text = protectInlineCode(text, tokens);
	text = protectUrls(text, tokens);
	text = protectLinkTargets(text, tokens);
	text = protectStructuredSpans(text, tokens);
	// Convert the internal NUL markers into the visible placeholder form.
	text = text.replace(NUL_MARKER, (_m, id: string) => `${prefix}${id}]]`);
	return { text, tokens: tokens.map((token) => token.value), prefix };
}

export class MarkdownProtectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MarkdownProtectionError';
	}
}

/** Restore placeholders; every token must appear exactly once. */
export function restoreMarkdown(protectedText: string, original: ProtectedMarkdown): string {
	let text = protectedText;
	original.tokens.forEach((token, index) => {
		const marker = `${original.prefix}${index}]]`;
		const count = text.split(marker).length - 1;
		if (count !== 1) {
			throw new MarkdownProtectionError(
				`Placeholder ${marker} appears ${count} times (expected exactly 1)`
			);
		}
		text = text.replace(marker, token);
	});
	if (text.includes(original.prefix)) {
		throw new MarkdownProtectionError('Untranslated placeholder left in output');
	}
	return text;
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort restore for a body that is still streaming: a placeholder the
 * model has not finished writing (or has not reached yet) cannot be swapped,
 * and a token may legitimately be missing. Unlike `restoreMarkdown` this never
 * throws - a preview must not fail a run that is still going.
 */
export function restoreMarkdownPartial(
	text: string,
	original: ProtectedMarkdown
): string {
	if (!text.includes(original.prefix)) return text;
	const marker = new RegExp(`${escapeForRegExp(original.prefix)}(\\d+)\\]\\]`, 'g');
	return text.replace(marker, (match, index: string) => original.tokens[Number(index)] ?? match);
}

function headingLevels(source: string): number[] {
	return source
		.split('\n')
		.map((line) => /^ {0,3}(#{1,6}) /.exec(line)?.[1].length ?? 0)
		.filter((level) => level > 0);
}

function countDirectives(source: string): number {
	return source.split('\n').filter((line) => /^ {0,3}:::/.test(line)).length;
}

function codePointLength(source: string): number {
	return [...source].length;
}

/**
 * Deterministic acceptance checks. These are the v1 quality gate; no
 * uncalibrated 0-100 LLM score is allowed to block a human accept.
 */
export interface ValidateTranslationOptions {
	/**
	 * The length ratio only makes sense on the assembled document: a short CJK
	 * chunk translated to English regularly exceeds 2.5x, so chunk-level checks
	 * pass `false` and the full-body check keeps the default.
	 */
	checkLengthRatio?: boolean;
	/**
	 * Override the default 0.35-2.5 window. Code-point ratios depend on the
	 * script pair: zh/ja -> en expands ~2.5-3.5x, en -> zh/ja contracts.
	 */
	lengthRatio?: { min: number; max: number };
}

export function validateTranslation(
	source: string,
	translated: string,
	options: ValidateTranslationOptions = {}
): { ok: true } | { ok: false; reason: string } {
	if (!translated.trim()) return { ok: false, reason: 'empty_output' };
	if (/<\/?(script|iframe|object|embed)\b/i.test(translated)) {
		return { ok: false, reason: 'html_injection' };
	}
	if (/javascript:\s*/i.test(translated)) return { ok: false, reason: 'javascript_url' };
	if (/\son[a-z]+\s*=/i.test(translated)) return { ok: false, reason: 'event_handler' };

	const sourceHeadings = headingLevels(source);
	const translatedHeadings = headingLevels(translated);
	if (
		sourceHeadings.length !== translatedHeadings.length ||
		sourceHeadings.some((level, index) => level !== translatedHeadings[index])
	) {
		return {
			ok: false,
			reason: `heading_structure ${sourceHeadings.join(',')} -> ${translatedHeadings.join(',')}`
		};
	}
	const sourceDirectives = countDirectives(source);
	const translatedDirectives = countDirectives(translated);
	if (sourceDirectives !== translatedDirectives) {
		return {
			ok: false,
			reason: `directive_count ${sourceDirectives} -> ${translatedDirectives}`
		};
	}
	// Every protected snippet (code fence, inline code, URL, link target,
	// mention, directive) must still exist exactly as it was.
	const sourceProtected = protectMarkdown(source);
	const translatedProtected = protectMarkdown(translated);
	if (sourceProtected.tokens.length !== translatedProtected.tokens.length) {
		return {
			ok: false,
			reason: `protected_span_count ${sourceProtected.tokens.length} -> ${translatedProtected.tokens.length}`
		};
	}
	for (let i = 0; i < sourceProtected.tokens.length; i++) {
		if (sourceProtected.tokens[i] !== translatedProtected.tokens[i]) {
			return { ok: false, reason: `protected_span_changed_at_${i}` };
		}
	}
	if (options.checkLengthRatio !== false) {
		const sourceLength = codePointLength(source);
		const translatedLength = codePointLength(translated);
		if (sourceLength > 0) {
			const ratio = translatedLength / sourceLength;
			const bounds = options.lengthRatio ?? { min: 0.35, max: 2.5 };
			if (ratio < bounds.min || ratio > bounds.max) {
				return { ok: false, reason: `length_ratio ${ratio.toFixed(2)}` };
			}
		}
	}
	return { ok: true };
}

/** Plain text length used by the summary threshold (code excluded). */
export function plainText(source: string): string {
	const protectedDoc = protectMarkdown(source);
	let text = protectedDoc.text;
	// Link text stays, destinations are already tokens.
	text = text.replace(/\[\[WL[^\]]*\]\]/g, ' ');
	text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	text = text.replace(/<[^>]+>/g, ' ');
	text = text.replace(/[*_~>#|]/g, ' ');
	return text.replace(/\s+/g, ' ').trim();
}

export function plainTextLength(source: string): number {
	return codePointLength(plainText(source));
}

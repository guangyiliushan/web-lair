/**
 * Comment text one step before rendering (comment P3a, grill Q4): split plain
 * text into text / link segments so the component can render them with native
 * Svelte templates - no raw-HTML escape hatch anywhere in the render path.
 * Only `http(s)` targets become links; everything else stays literal text.
 */

export interface CommentTextSegment {
	type: 'text' | 'link';
	/** Display content - for links this is the URL exactly as it was typed. */
	text: string;
	/** Normalised absolute URL; present on link segments only. */
	href?: string;
}

/** Candidate URLs; the tail is trimmed below before validation. */
const URL_RE = /https?:\/\/[^\s]+/gi;

/**
 * Punctuation that never belongs to the link when it sits at the tail: ASCII
 * sentence marks plus the CJK/typographic closers a commenter naturally types
 * after pasting a URL ("看这个 https://x.com。").
 */
const TRAILING_PUNCT = /[.,;:!?'"”’…。，、；：！？”’）］】」』》]+$/;

function isBalanced(value: string, open: string, close: string): boolean {
	let depth = 0;
	for (const char of value) {
		if (char === open) depth += 1;
		else if (char === close) depth -= 1;
	}
	return depth >= 0;
}

function trimUrlTail(raw: string): string {
	let value = raw.replace(TRAILING_PUNCT, '');
	// ASCII closing brackets are trimmed only while unmatched, so
	// "(see https://x.com/a)" keeps the URL intact but "https://x.com/a)"
	// loses the stray paren.
	while (value.endsWith(')') && !isBalanced(value, '(', ')')) value = value.slice(0, -1);
	while (value.endsWith(']') && !isBalanced(value, '[', ']')) value = value.slice(0, -1);
	return value;
}

function normalizeHttpUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (!url.hostname) return null;
		return url.href;
	} catch {
		return null;
	}
}

export function parseCommentText(input: string): CommentTextSegment[] {
	if (input.length === 0) return [];

	const segments: CommentTextSegment[] = [];
	let cursor = 0;
	for (const match of input.matchAll(URL_RE)) {
		const raw = match[0];
		const trimmed = trimUrlTail(raw);
		const href = trimmed.length > 0 ? normalizeHttpUrl(trimmed) : null;
		// Invalid candidates (bare scheme, other protocols, unparseable text)
		// stay literal text: the cursor does not move and the next flush
		// covers them.
		if (!href) continue;
		if (match.index > cursor) {
			segments.push({ type: 'text', text: input.slice(cursor, match.index) });
		}
		segments.push({ type: 'link', text: trimmed, href });
		cursor = match.index + trimmed.length;
	}
	if (cursor < input.length) {
		segments.push({ type: 'text', text: input.slice(cursor) });
	}
	return segments;
}

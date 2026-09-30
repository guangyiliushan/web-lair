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

/**
 * Reserved / private hosts are downgraded to text (security review): a
 * comment must not hand readers a one-click probe into their own LAN or a
 * loopback service. Kept to the unambiguous namespaces - a full allowlist or
 * a server-side link proxy is registered as future work.
 */
function isReservedHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
		return true;
	}
	if (host === '[::1]' || host === '[::]') return true;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (v4) {
		const [a, b] = v4.slice(1).map(Number);
		if (a === 0 || a === 10 || a === 127) return true;
		if (a === 192 && b === 168) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 169 && b === 254) return true;
	}
	return false;
}

/**
 * Candidates whose display string could be read differently from the actual
 * target are downgraded: backslashes and userinfo
 * (`https://evil.com\@trusted.com`, `https://trusted.com@evil.com`) are the
 * classic confusion vectors (security review).
 */
function isConfusableCandidate(value: string): boolean {
	if (value.includes('\\')) return true;
	const afterScheme = value.slice(value.indexOf('://') + 3);
	const authority = afterScheme.split(/[/?#]/)[0] ?? '';
	return authority.includes('@');
}

function normalizeHttpUrl(value: string): string | null {
	if (isConfusableCandidate(value)) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (!url.hostname || isReservedHost(url.hostname)) return null;
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

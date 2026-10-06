import { Tokenizer, TokenizerMode, type Token } from 'parse5';
import { normalizeHost } from './normalize.ts';

/**
 * Backlink detection (plan §4.8, 2026-10-06 ruling): the declared backlink
 * page is scanned with parse5's WHATWG-compliant tokenizer - never a regex -
 * so links inside comments or `<script>` bodies are not false positives and
 * entity-encoded or oddly-cased markup is not a false negative. `<base href>`
 * is honored; `http://` links to us count as a hit (noted); `rel=nofollow`
 * is recorded but still counts.
 */

export interface BacklinkFinding {
	found: boolean;
	/** Resolved href of the first matching link. */
	href?: string;
	/** Raw `rel` value of that link, when present. */
	rel?: string;
	/** Note fragments: `rel=nofollow`, `http link`, `via <base>`. */
	notes: string[];
}

/**
 * Decode a scanned page body, WHATWG sniff order (plan §4.8):
 * BOM > transport charset (`Content-Type`) > 1024-byte prescan (`<meta
 * charset>`) > UTF-8. Unknown labels fall back to UTF-8; decoding is
 * non-fatal (replacement characters beat a thrown scan).
 */
export function decodeHtmlBody(bytes: Uint8Array, contentType: string | null): string {
	let label: string | null = null;
	const startsWith = (prefix: number[]) =>
		bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
	if (startsWith([0xef, 0xbb, 0xbf])) label = 'utf-8';
	else if (startsWith([0xff, 0xfe])) label = 'utf-16le';
	else if (startsWith([0xfe, 0xff])) label = 'utf-16be';
	else if (contentType) {
		const match = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType);
		if (match) label = match[1];
	}
	if (!label) label = prescanCharset(bytes);
	if (!label) label = 'utf-8';
	try {
		return new TextDecoder(label, { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	}
}

/** The WHATWG "prescan a byte stream" approximation over the first 1024 bytes. */
function prescanCharset(bytes: Uint8Array): string | null {
	const head = bytes.subarray(0, 1024);
	let ascii = '';
	for (const byte of head) ascii += byte < 0x80 ? String.fromCharCode(byte) : ' ';
	const match = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(ascii);
	return match ? match[1] : null;
}

export function findBacklink(
	html: string,
	pageUrl: string,
	acceptedHosts: readonly string[]
): BacklinkFinding {
	const accepted = new Set(acceptedHosts);
	const finding: BacklinkFinding = { found: false, notes: [] };
	let baseHref: string | null = null;

	const baseResolved = (): string => {
		if (!baseHref) return pageUrl;
		try {
			return new URL(baseHref, pageUrl).href;
		} catch {
			return pageUrl;
		}
	};

	const RAWTEXT_TAGS = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes']);
	const RCDATA_TAGS = new Set(['title', 'textarea']);
	let tokenizer!: Tokenizer;
	tokenizer = new Tokenizer(
		{},
		{
			onStartTag(token) {
				if (finding.found) return;
				if (token.tagName === 'base') {
					if (baseHref === null) {
						const href = attrOf(token, 'href');
						if (href) baseHref = href;
					}
					return;
				}
				// Rawtext/RCDATA elements: switch the tokenizer mode so their
				// contents are not tokenized as markup (the standalone
				// tokenizer does not run tree construction; the matching end
				// tag returns it to the data state - verified 2026-10-06).
				if (token.tagName === 'script') {
					tokenizer.state = TokenizerMode.SCRIPT_DATA;
					return;
				}
				if (RAWTEXT_TAGS.has(token.tagName)) {
					tokenizer.state = TokenizerMode.RAWTEXT;
					return;
				}
				if (RCDATA_TAGS.has(token.tagName)) {
					tokenizer.state = TokenizerMode.RCDATA;
					return;
				}
				if (token.tagName !== 'a') return;
				const href = attrOf(token, 'href');
				if (!href) return;
				let resolved: URL;
				try {
					resolved = new URL(href, baseResolved());
				} catch {
					return;
				}
				const host = normalizeHost(resolved.hostname);
				if (!host || !accepted.has(host)) return;
				finding.found = true;
				finding.href = resolved.href;
				const rel = attrOf(token, 'rel');
				if (rel) {
					finding.rel = rel;
					if (/\bnofollow\b/i.test(rel)) finding.notes.push('rel=nofollow');
				}
				if (resolved.protocol === 'http:') finding.notes.push('http link');
				if (baseHref) finding.notes.push('via <base>');
			},
			onComment() {},
			onDoctype() {},
			onEndTag() {},
			onEof() {},
			onCharacter() {},
			onNullCharacter() {},
			onWhitespaceCharacter() {}
		}
	);

	try {
		tokenizer.write(html, true);
	} catch {
		// A tokenizer error only stops the scan; the finding so far stands.
	}
	return finding;
}

function attrOf(token: Token.TagToken, name: string): string | null {
	const match = token.attrs.find((attribute) => attribute.name.toLowerCase() === name);
	return match ? match.value : null;
}

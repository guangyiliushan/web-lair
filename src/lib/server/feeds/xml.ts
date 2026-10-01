/**
 * Minimal XML serialisation helpers for the feed endpoints (P3-b): the feeds
 * are hand-rolled on purpose — correctness is proven by unit tests and the
 * W3C Feed Validator gate, not by a runtime dependency.
 */

/**
 * Characters XML 1.0 cannot represent (the Char production): control
 * characters other than \t \n \r, lone surrogates and U+FFFE/U+FFFF. They
 * are invalid in text, attributes AND CDATA alike (review finding: a single
 * pasted form-feed used to make the whole feed non-well-formed), so every
 * writer path strips them before escaping.
 */
/* eslint-disable no-control-regex -- deliberate: filtering XML-invalid characters */
const INVALID_XML_CHARS = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;
/* eslint-enable no-control-regex */

/** Strips characters XML 1.0 cannot represent (control chars, lone surrogates). */
export function sanitizeXmlText(value: string): string {
	return value.replace(INVALID_XML_CHARS, '');
}

/** Escapes text and attribute values for XML 1.0. */
export function escapeXml(value: string): string {
	return sanitizeXmlText(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

/** Wraps an HTML payload in CDATA (splitting any nested `]]>` terminator). */
export function cdata(value: string): string {
	return `<![CDATA[${sanitizeXmlText(value).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

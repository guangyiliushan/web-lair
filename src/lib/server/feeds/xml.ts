/**
 * Minimal XML serialisation helpers for the feed endpoints (P3-b): the feeds
 * are hand-rolled on purpose — correctness is proven by unit tests and the
 * W3C Feed Validator gate, not by a runtime dependency.
 */

/** Escapes text and attribute values for XML 1.0. */
export function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

/** Wraps an HTML payload in CDATA (splitting any nested `]]>` terminator). */
export function cdata(value: string): string {
	return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

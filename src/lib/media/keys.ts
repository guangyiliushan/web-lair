/**
 * Content-addressed object keys (storage line §3.1) — the single source for
 * both BUILDERS (upload pipeline, scripts) and the PARSER grammar (/i proxy,
 * admin URL rendering). The extension is part of the key identity and the
 * variant suffix is appended to the canonical key; both live here so a
 * convention change lands everywhere at once (the round-2 review flagged the
 * previous five hand-written copies).
 */

/** Derived variant suffixes (plan §4.3). */
export const VARIANT_NAMES = ['thumb', 'preview', 'full'] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

/** Canonical key: `<sha[0:2]>/<sha256>.<ext>` (plan §3.1). */
export function objectKeyFor(contentHash: string, ext: string): string {
	return `${contentHash.slice(0, 2)}/${contentHash}.${ext}`;
}

/** Variant keys append the suffix to the canonical key (plan §3.1). */
export function variantKeyFor(objectKey: string, variant: VariantName): string {
	return `${objectKey}@${variant}`;
}

/**
 * `/i` key grammar (T9). Literal pattern rather than generated — but it
 * lives HERE so builders and parser are edited together; the positive and
 * negative cases are pinned by i-route tests. Groups: 1 = digest dir,
 * 2 = extension, 3 = variant name.
 */
export const KEY_PATTERN =
	/^([0-9a-f]{2})\/\1[0-9a-f]{62}(\.[a-z0-9]{1,10})?(?:@(thumb|preview|full))?$/;

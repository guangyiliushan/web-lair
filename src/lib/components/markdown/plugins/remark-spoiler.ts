import { createAttentionPlugin } from './attention-marker';

/**
 * remark-spoiler: the inline spoiler syntax `||text||` (spec 2 #6).
 *
 * Parsed by the micromark attention extension; flanking (4.3), escaping
 * (4.4) and inline-code/math isolation (4.2) hold by construction. The 4.2
 * table-cell ban is guaranteed by the GFM structure itself: inside a cell a
 * bare `||` is always consumed by the table parser as a cell delimiter, so
 * no spoiler node can form, and the escaped form `\|\|` stays literal per
 * 4.4 -- no post-parse guard is needed.
 */
export const remarkSpoiler = createAttentionPlugin({
	name: 'spoiler',
	markerCode: '|'.charCodeAt(0)
});

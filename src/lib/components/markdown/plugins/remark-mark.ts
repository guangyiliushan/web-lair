import { createAttentionPlugin } from './attention-marker';

/**
 * remark-mark: the inline highlight syntax `==text==` (spec 2 #5).
 *
 * Parsed by the micromark attention extension: flanking (4.3, `a == b == c`
 * does not trigger), escaping (4.4, `\=\=`), and inline-code/math isolation
 * (4.2) are guaranteed by the parsing architecture. Mark is NOT disabled
 * inside table cells -- the 4.2 ban is `||`-specific.
 */
export const remarkMark = createAttentionPlugin({
	name: 'mark',
	markerCode: '='.charCodeAt(0)
});

import type { Plugin } from 'unified';
import type { Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

/**
 * remark-math-guard: inline math guardrails (spec 2 #2).
 *
 * micromark-extension-math puts no word-boundary constraint on the single
 * `$` delimiter, so `价格 $5,成本 $3` would be misparsed as one inline
 * formula. This plugin enforces the spec:
 * - the char before the opening `$` must not be a letter/digit/underscore
 *   (Unicode `\p{L}`/`\p{N}` plus `_`)
 * - the char after the closing `$` must not be a digit (Unicode `\p{N}`;
 *   full-width and Arabic-Indic digits count)
 * Violating inlineMath nodes are restored to the literal source text per 5
 * (sliced from the original via position offsets, preserving escaping).
 *
 * `\(…\)` (spec 2 #2) is exempt: it is the unambiguous spelling the guard's
 * heuristics exist to avoid, so its nodes are left alone.
 *
 * Block `$$` formulas are bounded by line boundaries -- the guard holds
 * trivially and is not applied.
 */
/** shape of mdast-util-math's inlineMath node (the mdast package does not export this type) */
interface InlineMathLike {
	position?: {
		start?: { offset?: number };
		end?: { offset?: number };
	};
}

const LETTER_DIGIT_UNDERSCORE = /[\p{L}\p{N}_]/u;
const DIGIT = /[\p{N}]/u;

export const remarkMathGuard: Plugin<[], Root> = () => {
	return (tree, file) => {
		const source = String(file.value ?? '');

		visit(tree, 'inlineMath', (rawNode, index, parent) => {
			const node = rawNode as InlineMathLike;
			if (!parent || index == null) return;
			const { start, end } = node.position ?? {};
			if (start?.offset == null || end?.offset == null) return;

			const rawSlice = source.slice(start.offset, end.offset);
			// the unambiguous spelling is exempt from the `$` heuristics.
			// Char codes (92 = backslash, 40 = left paren) rather than a string
			// literal: this check has already been mangled once by layered
			// escaping between the source file and the running transform.
			if (rawSlice.charCodeAt(0) === 92 && rawSlice.charCodeAt(1) === 40) return;

			const charBefore = start.offset > 0 ? source[start.offset - 1] : undefined;
			const charAfter = end.offset < source.length ? source[end.offset] : undefined;

			const openerInvalid = charBefore !== undefined && LETTER_DIGIT_UNDERSCORE.test(charBefore);
			const closerInvalid = charAfter !== undefined && DIGIT.test(charAfter);
			if (!openerInvalid && !closerInvalid) return;

			const literal: Text = {
				type: 'text',
				value: rawSlice
			};
			parent.children.splice(index, 1, literal);
			return index + 1;
		});
	};
};

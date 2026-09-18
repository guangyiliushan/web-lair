import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import { warnOnce } from './plugin-warnings';
import { parseImageTail } from '$lib/components/markdown/image/tail-attrs';

/**
 * Image tail attributes (spec 2 #7): `![alt](src) {width=480 height=320}`.
 *
 * The `{` must be preceded by whitespace — the glued form `![a](u){w=1}`
 * stays literal. The closed key set is width/height (pixel counts, emitted as
 * img attributes so the size actually paints) and type (the `type=image` flag
 * the embed decision will read in the embed batch; it is not an HTML
 * attribute). The raw tail text is preserved on `data.mdTailAttrs` so the
 * embed batch and the editor can both re-parse it; rejected tokens warn once.
 */

const TAIL_REGEX = /^[ \t]+\{([^}]*)\}/;

export const remarkImageAttr: Plugin<[], Root> = () => {
	return (tree) => {
		visit(tree, 'image', (node, index, parent) => {
			if (!parent || index == null) return;
			const next = parent.children[index + 1];
			if (!next || next.type !== 'text') return;
			const match = TAIL_REGEX.exec(next.value);
			if (!match) return;

			const raw = match[1].trim();
			const parsed = parseImageTail(raw);
			for (const token of parsed.rejected) {
				warnOnce(`image-attr:${token}`, `image: tail attribute "${token}" ignored (spec 2 #7)`);
			}
			const props: Record<string, unknown> = {};
			if (parsed.width) props.width = parsed.width;
			if (parsed.height) props.height = parsed.height;

			// `mdTailAttrs` is a plugin-local payload. Module augmentation was
			// tried on both `Data` and `ImageData` — svelte-check's program does
			// not pick either up (unlike the PhrasingContentMap augmentation in
			// attention-marker.ts), so the assignment site carries the cast.
			node.data = {
				...(node.data ?? {}),
				...(Object.keys(props).length > 0
					? { hProperties: { ...(node.data?.hProperties ?? {}), ...props } }
					: {}),
				mdTailAttrs: raw
			} as typeof node.data;

			// Consume the attribute block so it never renders as text.
			next.value = next.value.slice(match[0].length);
			if (next.value === '' && parent.children.length > 1) {
				parent.children.splice(index + 1, 1);
			}
		});
	};
};

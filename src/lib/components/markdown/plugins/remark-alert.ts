import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';
import type { Blockquote, Paragraph, PhrasingContent } from 'mdast';
import { parseAlertMarker } from '$lib/components/markdown/alert/alert-types';

/**
 * remark-alert: GitHub-style alerts (spec 3.1) — the only alert syntax.
 *
 * A blockquote whose first paragraph starts with `[!NOTE]` / `[!TIP]` /
 * `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` (case-insensitive, plus the
 * fixed migration aliases) becomes `<div class="alert alert-{type}">`. The
 * text after the marker on the same line becomes an optional
 * `<p class="alert-title">`; the rest of the blockquote stays the alert body.
 *
 * The first paragraph is split line-wise (a soft break is a `\n` inside a
 * text node): every child of the first line — text and inline formatting
 * alike — stays in the title, children from the second line on move into a
 * new body paragraph, so inline markdown survives on both sides.
 *
 * Unknown markers and plain blockquotes are left untouched (5). The legacy
 * `:::info`-style callout branch was retired with this batch; old content
 * degrades to a plain container and its content is never swallowed.
 *
 * Divergence note: CommonMark lazy continuation merges an un-prefixed line
 * into the surrounding blockquote, so the render side treats such a line as
 * alert body text; the editor's import stops at the first non-`>` line and
 * leaves it outside the alert (no content is lost on either side).
 */
export const remarkAlert: Plugin<[], Root> = () => {
	return (tree) => {
		visit(tree, 'blockquote', (node: Blockquote) => {
			const first = node.children[0];
			if (!first || first.type !== 'paragraph') return;
			const paragraph = first as Paragraph;
			const head = paragraph.children[0];
			if (!head || head.type !== 'text') return;
			const parsed = parseAlertMarker(head.value);
			if (!parsed) return;
			const { type, rest } = parsed;

			// Strip the marker (and its trailing spaces) from the first text node.
			head.value = rest;

			// Locate the first line ending: a soft break is a `\n` inside a text
			// node, a hard break is a `break` node.
			const children: PhrasingContent[] = paragraph.children;
			let splitIndex = -1;
			let splitAt = 0;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (child.type === 'break') {
					splitIndex = i;
					break;
				}
				if (child.type === 'text') {
					const newlineIndex = child.value.indexOf('\n');
					if (newlineIndex !== -1) {
						splitIndex = i;
						splitAt = newlineIndex;
						break;
					}
				}
			}

			const isBlankText = (child: PhrasingContent): boolean =>
				child.type === 'text' && child.value === '';
			const titleChildren: PhrasingContent[] = [];
			const bodyChildren: PhrasingContent[] = [];
			if (splitIndex === -1) {
				for (const child of children) if (!isBlankText(child)) titleChildren.push(child);
			} else {
				for (let i = 0; i < splitIndex; i++) {
					if (!isBlankText(children[i])) titleChildren.push(children[i]);
				}
				const splitChild = children[splitIndex];
				if (splitChild.type === 'text') {
					const before = splitChild.value.slice(0, splitAt);
					const after = splitChild.value.slice(splitAt + 1);
					if (before) titleChildren.push({ ...splitChild, value: before });
					if (after) bodyChildren.push({ type: 'text', value: after });
				}
				// A `break` at the split is dropped: the paragraph split itself
				// expresses the line break.
				for (let i = splitIndex + 1; i < children.length; i++) bodyChildren.push(children[i]);
			}

			if (titleChildren.length > 0) {
				paragraph.children = titleChildren;
				paragraph.data = {
					...(paragraph.data ?? {}),
					hName: 'p',
					hProperties: {
						...(paragraph.data?.hProperties ?? {}),
						className: ['alert-title']
					}
				};
			} else {
				node.children.shift();
			}

			if (bodyChildren.length > 0) {
				const bodyParagraph: Paragraph = { type: 'paragraph', children: bodyChildren };
				node.children.splice(titleChildren.length > 0 ? 1 : 0, 0, bodyParagraph);
			}

			node.data = {
				...(node.data ?? {}),
				hName: 'div',
				hProperties: {
					...(node.data?.hProperties ?? {}),
					className: ['alert', `alert-${type}`]
				}
			};
		});
	};
};

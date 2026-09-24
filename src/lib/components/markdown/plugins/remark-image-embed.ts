import type { Plugin } from 'unified';
import type { Root, Image, Link } from 'mdast';
import { visit, SKIP } from 'unist-util-visit';
import type { ContainerDirective } from 'mdast-util-directive';
import { decideImage } from '$lib/components/markdown/embed/resolve';

/**
 * Embed decision (spec 3.4): every bare `!` image node runs through
 * decideImage; images stay images, everything else becomes a zero-request
 * placeholder card — an `<a class="embed-card" data-embed data-url>` carrying
 * the alt text (or the URL when the alt is empty) so the no-JS fallback is a
 * plain link, per the spec 7 degrade matrix. The card components mount over
 * these anchors in the client enhancement batch.
 *
 * Guards: bare URLs and normal links are never upgraded (only `!` nodes reach
 * the decision), and an image inside a link label stays an image — replacing
 * it would nest anchors, which parse5 resolves by emptying the outer link.
 *
 * Runs after remark-image-attr (whose mdTailAttrs payload feeds rule 1) and
 * after remark-directive (whose normalised grid attributes feed rule 2).
 */

/** The payload remark-image-attr stores (mdast Data has no shared type). */
interface ImageDataPayload {
	mdTailAttrs?: string;
}

export const remarkImageEmbed: Plugin<[], Root> = () => {
	return (tree) => {
		// Pass 1 — marks for rule 2 (image-mode grids) and the link guard.
		// The grid attributes are read from remark-directive's normalised
		// hProperties, so the closed sets live in one place only.
		const inImageContainer = new WeakSet<Image>();
		const insideLink = new WeakSet<Image>();
		visit(tree, 'containerDirective', (node) => {
			const directive = node as unknown as ContainerDirective;
			if (directive.name !== 'grid') return;
			const props = directive.data?.hProperties as
				{ dataType?: string; dataLayout?: string } | undefined;
			const imageMode =
				props?.dataType === 'images' ||
				props?.dataLayout === 'masonry' ||
				props?.dataLayout === 'carousel';
			if (!imageMode) return;
			visit(directive, 'image', (image: Image) => {
				inImageContainer.add(image);
			});
		});
		visit(tree, 'link', (link) => {
			visit(link, 'image', (image: Image) => {
				insideLink.add(image);
			});
		});

		// Pass 2 — rules 1/3/4/5 on every bare image node.
		visit(tree, 'image', (node: Image, index, parent) => {
			if (index == null || !parent) return;
			if (insideLink.has(node)) return;
			const decision = decideImage({
				url: node.url,
				tailAttrs: (node.data as ImageDataPayload | undefined)?.mdTailAttrs,
				inImageContainer: inImageContainer.has(node)
			});
			if (decision.kind === 'image') return;

			const card: Link = {
				type: 'link',
				url: node.url,
				children: [{ type: 'text', value: node.alt?.trim() || node.url }],
				data: {
					hProperties: {
						className: ['embed-card'],
						dataEmbed: decision.provider,
						dataUrl: node.url
					}
				}
			};
			parent.children.splice(index, 1, card);
			return [SKIP, index];
		});
	};
};

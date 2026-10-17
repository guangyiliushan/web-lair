import { describe, expect, it } from 'vitest';
import { SEGMENT_FIXTURES } from '$lib/components/comments/segment-fixtures';
import { collectAnchorBlocks } from './comment-anchor';
import { renderMarkdownTree } from './markdown';

/**
 * Server half of the two-pipeline conformance check (comment P3b, spec §3).
 * The browser spec (`segment-dom.svelte.spec.ts`) asserts the same expected
 * texts over the DOM walker; a divergence in either walker breaks a test here
 * before it can turn into a reader-side mis-anchor.
 */
describe('server block directory conformance', () => {
	for (const fixture of SEGMENT_FIXTURES) {
		it(fixture.name, async () => {
			const tree = await renderMarkdownTree(fixture.markdown);
			expect(collectAnchorBlocks(tree).map((block) => block.text)).toEqual(fixture.blocks);
		});
	}
});

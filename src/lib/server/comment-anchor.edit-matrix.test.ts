import { describe, expect, it } from 'vitest';
import { codePointLength, codePointSlice } from '$lib/utils/comment-anchor';
import {
	collectAnchorBlocks,
	resolveAnchor,
	type AnchorBlock,
	type CommentAnchor
} from './comment-anchor';
import { renderMarkdownTree } from './markdown';

/**
 * Spec §12.2 edit matrix: every edit class has one defined outcome, and a
 * *unique* quote never lands on a different block. "Moved far out of the ±2
 * window" and "quote rewritten" are orphans by design (folded area), not
 * mis-anchors — the suite pins both so a future widening of the window cannot
 * silently start re-pointing comments at the wrong paragraph.
 */
async function blocksOf(markdown: string): Promise<AnchorBlock[]> {
	return collectAnchorBlocks(await renderMarkdownTree(markdown));
}

function anchorIn(block: AnchorBlock, needle: string): CommentAnchor {
	const start = [...block.text].join('').indexOf(needle);
	if (start < 0) throw new Error(`needle not in block: ${needle}`);
	// `indexOf` on the code-point-joined string measures UTF-16 against the
	// joined string; convert back through codePointLength for astral safety.
	const prefixText = [...block.text].join('').slice(0, start);
	const codePointStart = codePointLength(prefixText);
	const codePointEnd = codePointStart + codePointLength(needle);
	return {
		v: 1,
		lang: 'en',
		block: { hash: block.hash, occ: block.occ, ord: block.ord },
		range: { start: codePointStart, end: codePointEnd },
		quote: {
			exact: codePointSlice(block.text, codePointStart, codePointEnd),
			prefix: codePointSlice(block.text, Math.max(0, codePointStart - 12), codePointStart),
			suffix: codePointSlice(block.text, codePointEnd, Math.min(codePointLength(block.text), codePointEnd + 12))
		}
	};
}

async function resolveIn(markdown: string, anchor: CommentAnchor) {
	const blocks = await blocksOf(markdown);
	const resolved = resolveAnchor(blocks, anchor);
	return resolved ? { text: resolved.block.text, exact: codePointSlice(resolved.block.text, resolved.start, resolved.end) } : null;
}

const BASE = ['## 标题', '', '第一段：锚点句子在中间。尾巴。', '', '第二段：另一段内容。', '', '第三段：结束。'].join('\n');

async function baseAnchor(): Promise<CommentAnchor> {
	const blocks = await blocksOf(BASE);
	const target = blocks.find((block) => block.text.includes('锚点句子'));
	if (!target) throw new Error('fixture lost its block');
	return anchorIn(target, '锚点句子');
}

describe('spec §12.2 edit matrix', () => {
	it('改字 elsewhere in the same block still resolves the quote', async () => {
		const anchor = await baseAnchor();
		const edited = BASE.replace('尾巴。', '尾巴改过了。');
		expect(await resolveIn(edited, anchor)).toMatchObject({ exact: '锚点句子' });
	});

	it('插句 above shifts the ordinal and still resolves (L2 window)', async () => {
		const anchor = await baseAnchor();
		const edited = BASE.replace('## 标题\n\n', '## 标题\n\n新插入的一段。\n\n');
		expect(await resolveIn(edited, anchor)).toMatchObject({ exact: '锚点句子' });
	});

	it('删句 before the quote inside the same block resolves at the shifted range', async () => {
		const anchor = await baseAnchor();
		const edited = BASE.replace('第一段：锚点句子', '锚点句子');
		expect(await resolveIn(edited, anchor)).toMatchObject({ exact: '锚点句子' });
	});

	it('重排 far away still resolves through the unchanged block hash', async () => {
		const anchor = await baseAnchor();
		const edited = [
			'## 标题',
			'',
			'第二段：另一段内容。',
			'',
			'第三段：结束。',
			'',
			'第四段：补一段。',
			'',
			'第五段：再补一段。',
			'',
			'第一段：锚点句子在中间。尾巴。'
		].join('\n');
		// The paragraph text did not change, so the content hash finds it at its
		// new ordinal — position is a hint, not the identity (spec §7).
		expect(await resolveIn(edited, anchor)).toMatchObject({ exact: '锚点句子' });
	});

	it('改写 the quoted sentence orphans (never re-points)', async () => {
		const anchor = await baseAnchor();
		const edited = BASE.replace('锚点句子', '换了一个说法');
		expect(await resolveIn(edited, anchor)).toBeNull();
	});

	it('删段 orphans the anchor', async () => {
		const anchor = await baseAnchor();
		const edited = ['## 标题', '', '第二段：另一段内容。', '', '第三段：结束。'].join('\n');
		expect(await resolveIn(edited, anchor)).toBeNull();
	});

	it('duplicate blocks resolve to the surviving identical block (explicit, not a bug)', async () => {
		const duplicated = ['重复段落。', '', '重复段落。'].join('\n');
		const blocks = await blocksOf(duplicated);
		const second = blocks[1];
		const anchor = anchorIn(second, '重复段落');
		// Deleting the first leaves one identical block; spec §12.2 accepts
		// resolving to it (same text is same target by definition).
		expect(await resolveIn('重复段落。', anchor)).toMatchObject({ exact: '重复段落' });
	});

	it('a unique quote never lands on a different block', async () => {
		const anchor = await baseAnchor();
		const edited = [
			'## 标题',
			'',
			'第一段：被改写的内容。',
			'',
			'第二段：另一段内容。',
			'',
			'第三段：结束。'
		].join('\n');
		const resolved = await resolveIn(edited, anchor);
		// Either the quote is found intact somewhere, or the anchor orphans;
		// it must never resolve to text that does not contain the exact quote.
		if (resolved) expect(resolved.exact).toBe('锚点句子');
		else expect(resolved).toBeNull();
	});
});

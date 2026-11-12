import { describe, expect, it, vi } from 'vitest';
import { AiError } from './errors';
import { protectMarkdown } from './protect';
import { segmentMarkdown } from './segment';
import { lengthRatioFor, translateChunks, type ChunkCallRequest } from './translate';

/**
 * The chunk orchestration is the part that can silently corrupt a long
 * translation: wrong continuity prompt, a placeholder lost at a chunk
 * boundary, or a preview that leaks an unrestored token. The caller seam lets
 * these tests run without a provider or a database.
 */

function chunksFor(source: string, maxChars = 3000) {
	const protectedDoc = protectMarkdown(source);
	return {
		protectedDoc,
		chunks: segmentMarkdown(protectedDoc.text, { maxChars })
	};
}

const identity = async (request: ChunkCallRequest) => ({
	text: request.chunk.text,
	provider: 'test-provider',
	model: 'test-model'
});

describe('translateChunks', () => {
	it('makes one call and no part prompt for a single-chunk document', async () => {
		const { protectedDoc, chunks } = chunksFor('# Title\n\nA short body.');
		const call = vi.fn(identity);

		const result = await translateChunks(
			{ baseSystem: 'BASE', protectedDoc, chunks },
			call as never
		);

		expect(call).toHaveBeenCalledTimes(1);
		expect((call.mock.calls[0][0] as ChunkCallRequest).system).toBe('BASE');
		expect(result.content).toBe('# Title\n\nA short body.');
		expect(result.provider).toBe('test-provider');
	});

	it('walks a long document in order with continuity instructions', async () => {
		const paragraph = '字'.repeat(1000);
		const source = [paragraph, paragraph, paragraph, paragraph].join('\n\n');
		const { protectedDoc, chunks } = chunksFor(source, 2500);
		expect(chunks.length).toBeGreaterThan(1);
		const systems: string[] = [];
		const call = vi.fn(async (request: ChunkCallRequest) => {
			systems.push(request.system);
			return { text: request.chunk.text, provider: 'p', model: 'm' };
		});

		const result = await translateChunks(
			{ baseSystem: 'BASE', protectedDoc, chunks },
			call as never
		);

		expect(call).toHaveBeenCalledTimes(chunks.length);
		expect(systems[0]).toContain('part 1 of');
		expect(systems[1]).toContain('part 2 of');
		expect(systems[1]).toContain('previous part ended with');
		expect(result.content).toBe(source);
	});

	it('rejects a chunk whose protected span changed', async () => {
		const { protectedDoc, chunks } = chunksFor('Use `npm` now.');
		const call = vi.fn(async (request: ChunkCallRequest) => ({
			text: request.chunk.text.replace('[[WL0]]', '[[WL1]]'),
			provider: 'p',
			model: 'm'
		}));

		await expect(
			translateChunks({ baseSystem: 'BASE', protectedDoc, chunks }, call as never)
		).rejects.toMatchObject({ code: 'invalid_output' });
	});

	it('restores placeholders in the live preview', async () => {
		const { protectedDoc, chunks } = chunksFor('Use `npm` now.');
		const seen: string[] = [];
		const call = vi.fn(async (request: ChunkCallRequest) => {
			request.onProgress?.('Use [[WL0]] now');
			return { text: request.chunk.text, provider: 'p', model: 'm' };
		});

		await translateChunks(
			{
				baseSystem: 'BASE',
				protectedDoc,
				chunks,
				onProgress: (text) => seen.push(text)
			},
			call as never
		);

		expect(seen.at(-1)).toBe('Use `npm` now');
	});

	it('reuses completed chunks and reports only the new ones', async () => {
		const paragraph = '字'.repeat(1000);
		const source = [paragraph, paragraph, paragraph].join('\n\n');
		const { protectedDoc, chunks } = chunksFor(source, 2500);
		expect(chunks.length).toBe(2);
		const completed = chunks.map((_, index) => (index === 0 ? '已完成的第一段' : undefined));
		const seen: number[] = [];
		const call = vi.fn(async (request: ChunkCallRequest) => ({
			text: request.chunk.text,
			provider: 'p',
			model: 'm'
		}));

		const result = await translateChunks(
			{
				baseSystem: 'BASE',
				protectedDoc,
				chunks,
				completed,
				onChunk: (index) => seen.push(index)
			},
			call as never
		);

		expect(call).toHaveBeenCalledTimes(1);
		expect(seen).toEqual([1]);
		// The resumed text is context for the next chunk, not a fresh charge.
		expect((call.mock.calls[0][0] as ChunkCallRequest).system).toContain('已完成的第一段');
		expect(result.content.startsWith('已完成的第一段')).toBe(true);
		expect(result.content).toContain(paragraph);
	});

	it('uses script-pair length windows for the assembled check', () => {
		// The first live zh -> en run produced 3.41x, which the generic 2.5
		// ceiling rejected; CJK -> Latin expands and Latin -> CJK contracts.
		expect(lengthRatioFor('zh-cn', 'en')).toEqual({ min: 1, max: 5 });
		expect(lengthRatioFor('ja', 'en')).toEqual({ min: 1, max: 5 });
		expect(lengthRatioFor('en', 'zh-cn')).toEqual({ min: 0.15, max: 1 });
		expect(lengthRatioFor('zh-cn', 'ja')).toEqual({ min: 0.35, max: 2.5 });
	});

	it('refuses an empty chunk list', async () => {
		const protectedDoc = protectMarkdown('text');
		await expect(
			translateChunks({ baseSystem: 'BASE', protectedDoc, chunks: [] }, identity as never)
		).rejects.toBeInstanceOf(AiError);
	});
});

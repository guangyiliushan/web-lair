import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtmlSync } from '$lib/components/markdown';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { conformanceCases } from './conformance-cases';

/**
 * Dual-pipeline conformance test: the same case set must pass on both the
 * client light pipeline and the full server pipeline.
 */

function assertCase(html: string, input: string, contains: string[], notContains?: string[]) {
	for (const fragment of contains) {
		expect(html, `${input}\n→ 应包含 ${fragment}\n实际: ${html}`).toContain(fragment);
	}
	for (const fragment of notContains ?? []) {
		expect(html, `${input}\n→ 不应包含 ${fragment}\n实际: ${html}`).not.toContain(fragment);
	}
}

describe.each(conformanceCases)('$id ($spec)', (testCase) => {
	it('light pipeline', () => {
		const html = renderMarkdownToHtmlSync(testCase.input);
		assertCase(html, testCase.input, testCase.contains, testCase.notContains);
	});

	it('server pipeline', async () => {
		const html = await renderMarkdownToHtml(testCase.input);
		assertCase(html, testCase.input, testCase.contains, testCase.notContains);
	});
});

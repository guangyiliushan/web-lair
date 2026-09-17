import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtmlSync } from '$lib/components/markdown';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { conformanceCases } from './conformance-cases';

/**
 * Conformance 双管线测试:同一用例集必须同时通过
 * 客户端轻量管线与服务器全量管线。
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

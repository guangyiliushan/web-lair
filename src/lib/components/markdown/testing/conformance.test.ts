import { describe, expect, it } from 'vitest';
import { renderMarkdownToHtmlSync } from '$lib/components/markdown';
import { renderMarkdownToHtml } from '$lib/server/markdown';
import { conformanceCases } from './conformance-cases';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Default labels and fallbacks come from the message catalog; pin the locale
// so the case expectations stay in sync with the zh-cn catalog (same
// convention as the e2e fixtures that assert Chinese copy).
overwriteGetLocale(() => 'zh-cn');

/**
 * Dual-pipeline conformance test: the same case set must pass on both the
 * client light pipeline and the full server pipeline.
 */

function assertCase(html: string, input: string, contains: string[], notContains?: string[]) {
	// `translate="no"` on every code/pre element is defence in depth;
	// the conformance corpus predates that attribute and asserts structural
	// fragments, so normalise it away here. `markdown.test.ts` pins the
	// attribute itself.
	const normalized = html.replace(/ translate="no"/g, '');
	for (const fragment of contains) {
		expect(normalized, `${input}\n→ 应包含 ${fragment}\n实际: ${html}`).toContain(fragment);
	}
	for (const fragment of notContains ?? []) {
		expect(normalized, `${input}\n→ 不应包含 ${fragment}\n实际: ${html}`).not.toContain(fragment);
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

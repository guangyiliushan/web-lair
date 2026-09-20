import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import EditorChainFixture from './editor-chain-fixture.svelte';

import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

// Full chain: the seed-content verification the plan calls for — markdown in,
// WYSIWYG out, edit, serialise back (the save path the admin UI uses). The
// alert is the strongest WYSIWYG witness (it is a decorated editor node, not
// a plain text run); the serialised output must carry every new-syntax
// construct back out of the editor.
const SOURCE = [
	'> [!NOTE] 提示标题',
	'> 告警内容',
	'',
	'==高亮== 与 ||剧透|| 文本',
	'',
	'![仓库](https://github.com/foo/bar)'
].join('\n');

describe('editor full chain (edit → WYSIWYG → save)', () => {
	it('renders the alert live and round-trips the new syntax on save', async () => {
		await page.viewport(1280, 800);
		const screen = await render(EditorChainFixture, { initialMarkdown: SOURCE });

		// WYSIWYG: the alert's content renders as editable text in the editor
		await expect.element(page.getByText('告警内容')).toBeVisible();
		// and the alert kept its decorated block (spec 3.1 syntax in the DOM)
		expect(screen.container.querySelector('.alert, [class*="alert"]')).not.toBeNull();

		// edit: focus the editor and type
		const user = userEvent.setup();
		const ed = page.getByRole('textbox', { name: '输入正文...' });
		await ed.click();
		await user.keyboard('{End}');
		await user.keyboard('X');
		await new Promise((resolve) => setTimeout(resolve, 80));

		// save: the serialised markdown carries every construct back out
		const saved = screen.container.querySelector('[data-latest-markdown]')?.textContent ?? '';
		expect(saved).toContain('> [!NOTE]');
		expect(saved).toContain('==高亮==');
		expect(saved).toContain('||剧透||');
		expect(saved).toContain('![仓库](https://github.com/foo/bar)');
		expect(saved).toContain('X');
	});
});

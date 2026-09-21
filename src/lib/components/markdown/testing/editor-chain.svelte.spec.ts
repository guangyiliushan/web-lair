import { userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { mountEditorFixture, readSaved } from './editor-spec-helpers';

// Full chain: markdown in, WYSIWYG out, edit, serialise back (the save path
// the admin UI uses). The alert is the strongest WYSIWYG witness (a decorated
// editor node, not a plain text run); the serialised output must carry every
// new-syntax construct back out of the editor.
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
		const { screen } = await mountEditorFixture(SOURCE);

		// WYSIWYG: the alert's content renders as editable text in the editor
		// (scoped to the editor root: the fixture's output pane echoes the same
		// string once a change has fired)
		await expect
			.poll(
				() => screen.container.querySelector('[data-lexical-editor="true"]')?.textContent ?? '',
				{
					timeout: 15_000
				}
			)
			.toContain('告警内容');
		// and the alert kept its decorated block (spec 3.1 syntax in the DOM)
		expect(screen.container.querySelector('.alert, [class*="alert"]')).not.toBeNull();

		// edit: type into the alert body (the fixture focused the editor)
		const user = userEvent.setup();
		await user.keyboard('{End}');
		await user.keyboard('X');

		// save: the serialised markdown carries every construct back out
		// the save path is debounced; under full-suite load the event can
		// take well past the 1 s default poll budget
		await expect.poll(() => readSaved(screen.container), { timeout: 15_000 }).toContain('X');
		const saved = readSaved(screen.container);
		expect(saved).toContain('> [!NOTE]');
		expect(saved).toContain('==高亮==');
		expect(saved).toContain('||剧透||');
		expect(saved).toContain('![仓库](https://github.com/foo/bar)');
	});
});

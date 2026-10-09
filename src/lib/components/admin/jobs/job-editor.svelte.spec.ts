import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import JobEditorTestHost from './job-editor-test-host.svelte';

/**
 * Browser teeth for the CodeMirror wrapper (J-2, plan §5.6): mount, typing ->
 * onChange, Mod-s -> onSave, external value adoption without echo, read-only
 * surface. Assertions poll the live DOM (house style) because CodeMirror
 * builds its surface asynchronously after mount.
 */

describe('job editor (CodeMirror thin wrapper)', () => {
	it('mounts with the initial document', async () => {
		await page.viewport(900, 600);
		await render(JobEditorTestHost, { initial: 'export default {};\n' });
		await expect
			.poll(() => document.querySelector('.cm-editor')?.textContent ?? '', { timeout: 15_000 })
			.toContain('export default');
	});

	it('emits changes on typing and triggers save on Mod-s', async () => {
		await page.viewport(900, 600);
		await render(JobEditorTestHost, { initial: 'const a = 1;\n' });
		const content = document.querySelector('.cm-content') as HTMLElement;
		expect(content).not.toBeNull();
		await userEvent.click(content);
		await userEvent.keyboard('{Control>}s{/Control}');
		await expect
			.poll(
				() => Number(document.querySelector('[data-testid="save-count"]')?.textContent ?? '0'),
				{ timeout: 15_000 }
			)
			.toBeGreaterThanOrEqual(1);
		await userEvent.keyboard('XY');
		await expect
			.poll(() => document.querySelector('[data-testid="change-echo"]')?.textContent ?? '', {
				timeout: 15_000
			})
			.toContain('XY');
	});

	it('adopts external value changes without echoing them back', async () => {
		await page.viewport(900, 600);
		await render(JobEditorTestHost, { initial: 'first\n', reloadValue: 'second\n' });
		await expect
			.poll(() => document.querySelector('.cm-editor')?.textContent ?? '', { timeout: 15_000 })
			.toContain('first');
		const reload = document.querySelector('[data-testid="reload"]') as HTMLButtonElement;
		await userEvent.click(reload);
		await expect
			.poll(() => document.querySelector('.cm-editor')?.textContent ?? '', { timeout: 15_000 })
			.toContain('second');
		expect(document.querySelector('[data-testid="change-echo"]')?.textContent).toBe('');
	});

	it('read-only renders a non-editable surface and swallows typing', async () => {
		await page.viewport(900, 600);
		await render(JobEditorTestHost, { initial: 'const a = 1;\n', readonly: true });
		await expect
			.poll(() => document.querySelector('.cm-content')?.getAttribute('contenteditable'), {
				timeout: 15_000
			})
			.toBe('false');
		const content = document.querySelector('.cm-content') as HTMLElement;
		await userEvent.click(content);
		await userEvent.keyboard('ZZZ');
		expect(document.querySelector('.cm-editor')?.textContent ?? '').not.toContain('ZZZ');
	});
});

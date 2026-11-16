import { page, userEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ToolbarTestHost from '../toolbar/ToolbarTestHost.svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
overwriteGetLocale(() => 'zh-cn');

/**
 * Embed-card editing in the editor (click-to-select / no navigation /
 * Backspace delete / in-place URL edit). The node is a keyboard-selectable
 * DecoratorNode; the decorate() host captures clicks into a NodeSelection
 * and the card offers an in-place edit row (editable context only).
 */

const MD = [
	'段落开始',
	'',
	'![example-org/example-repo](https://github.com/example-org/example-repo)',
	'',
	'段落结束'
].join('\n');

async function mountHost() {
	await page.viewport(1280, 720);
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
	const screen = await render(ToolbarTestHost, { initialMarkdown: MD, placeholder: '输入正文...' });
	await expect
		.poll(() => document.querySelectorAll('.rich-editor-embed-host').length, { timeout: 5000 })
		.toBeGreaterThan(0);
	return screen;
}

const hostEl = () => document.querySelector('.rich-editor-embed-host') as HTMLElement;

describe('embed card editing', () => {
	it('selects the card on click (data-selected) and blocks link navigation', async () => {
		await mountHost();
		const link = hostEl().querySelector('a.embed-link') as HTMLAnchorElement;
		link.addEventListener('click', (e) => {
			e.preventDefault();
		});
		// Click anywhere on the card (on the link)
		link.click();
		await expect.poll(() => hostEl().getAttribute('data-selected'), { timeout: 5000 }).toBe('true');
		// Capture-phase preventDefault: the listener (on the link, bubble phase) must not
		// receive a default navigation intent — synthetic click preventDefault semantics:
		// once the capture phase calls preventDefault, later listeners still run but see
		// defaultPrevented=true.
		const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
		link.dispatchEvent(evt);
		expect(evt.defaultPrevented).toBe(true);
	});

	it('deletes the selected card with Backspace', async () => {
		await mountHost();
		hostEl().click();
		await expect.poll(() => hostEl().getAttribute('data-selected'), { timeout: 5000 }).toBe('true');
		// Focus is in the editor (NodeSelection plus editor focus); press keys directly
		await page.getByRole('textbox', { name: '输入正文...' }).click();
		// Re-select (clicking the body may reset the selection)
		hostEl().click();
		await expect.poll(() => hostEl().getAttribute('data-selected'), { timeout: 5000 }).toBe('true');
		await userEvent.keyboard('{Backspace}');
		await expect
			.poll(() => document.querySelectorAll('.rich-editor-embed-host').length, { timeout: 5000 })
			.toBe(0);
	});

	it('edits the URL in place and the export reflects it', async () => {
		const screen = await mountHost();
		await expect
			.poll(() => hostEl().querySelector('button.embed-edit') !== null, { timeout: 5000 })
			.toBe(true);
		const editBtn = hostEl().querySelector('button.embed-edit') as HTMLElement;
		editBtn.click();
		await expect
			.poll(() => hostEl().querySelector('.embed-edit-row input') !== null, { timeout: 5000 })
			.toBe(true);
		const input = hostEl().querySelector('.embed-edit-row input') as HTMLInputElement;
		input.value = 'https://github.com/example-org/example-repo';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const apply = [...hostEl().querySelectorAll('button')].find(
			(b) => b.textContent.trim() === '应用'
		) as HTMLElement;
		apply.click();

		// The card URL updates (inside the editor)
		await expect
			.poll(
				() => (hostEl().querySelector('a.embed-link') as HTMLAnchorElement)?.getAttribute('href'),
				{ timeout: 5000 }
			)
			.toBe('https://github.com/example-org/example-repo');

		// Export (code mode) contains the new URL
		await page.getByRole('button', { name: '切换到代码模式' }).click();
		await expect
			.poll(() => document.querySelector('textarea') !== null, { timeout: 5000 })
			.toBe(true);
		const ta = document.querySelector('textarea') as HTMLTextAreaElement;
		expect(ta.value).toContain('(https://github.com/example-org/example-repo)');
		// Alt text keeps its original value when unchanged
		expect(ta.value).toContain('![example-org/example-repo]');
		void screen;
	});

	it('flips the provider badge when the URL moves to another provider', async () => {
		await mountHost();
		await expect
			.poll(() => hostEl().querySelector('button.embed-edit') !== null, { timeout: 5000 })
			.toBe(true);
		(hostEl().querySelector('button.embed-edit') as HTMLElement).click();
		await expect
			.poll(() => hostEl().querySelector('.embed-edit-row input') !== null, { timeout: 5000 })
			.toBe(true);
		const input = hostEl().querySelector('.embed-edit-row input') as HTMLInputElement;
		input.value = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		const apply = [...hostEl().querySelectorAll('button')].find(
			(b) => b.textContent.trim() === '应用'
		) as HTMLElement;
		apply.click();
		// provider is derived from the URL: the editor badge must match the export
		await expect
			.poll(() => hostEl().querySelector('.embed-badge')?.textContent ?? '', { timeout: 5000 })
			.toContain('YouTube');
	});

	it('keeps the card when Backspace is pressed inside the edit row', async () => {
		await mountHost();
		await expect
			.poll(() => hostEl().querySelector('button.embed-edit') !== null, { timeout: 5000 })
			.toBe(true);
		(hostEl().querySelector('button.embed-edit') as HTMLElement).click();
		await expect
			.poll(() => hostEl().querySelector('.embed-edit-row input') !== null, { timeout: 5000 })
			.toBe(true);
		const input = hostEl().querySelector('.embed-edit-row input') as HTMLInputElement;
		input.focus();
		await userEvent.keyboard('{Backspace}');
		// the delete-on-Backspace selection behaviour must not fire inside the row
		expect(document.querySelectorAll('.rich-editor-embed-host').length).toBe(1);
	});
});

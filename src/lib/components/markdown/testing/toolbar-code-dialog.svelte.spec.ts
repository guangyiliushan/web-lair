import { page, userEvent } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import {
	editorToolbar,
	mountEditorFixture,
	readSaved,
	searchBoxValue
} from './editor-spec-helpers';

// The code-block button opens a language picker (search + select); the chosen
// language must land in the fence info string and round-trip through save.
describe('code block language picker', () => {
	it('opens the dialog, searches and inserts with the chosen language', async () => {
		const { screen } = await mountEditorFixture('前文');
		await editorToolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('combobox').fill('tsx');
		await page.getByRole('option', { name: 'tsx' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```tsx');
		// the caret lands inside the fresh fence: typing continues in it
		const user = userEvent.setup();
		await user.keyboard('Z');
		await expect.poll(() => readSaved(screen.container)).toMatch(/```tsx\nZ/);
	});

	it('offers the typed query as a custom language', async () => {
		const { screen } = await mountEditorFixture('前文');
		await editorToolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('combobox').fill('brainfuck');
		await page.getByRole('option', { name: /brainfuck/ }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```brainfuck');
	});

	it('inserts a plain fence without a language', async () => {
		const { screen } = await mountEditorFixture('前文');
		await editorToolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('option', { name: '纯文本' }).click();
		await expect.poll(() => readSaved(screen.container)).toMatch(/```\n/);
	});

	it('sanitises free-form languages to a single info token', async () => {
		const { screen } = await mountEditorFixture('前文');
		await editorToolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('combobox').fill('a b`c');
		await page.getByRole('option', { name: /abc/ }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```abc');
	});

	it('resets the search when the dialog is reopened', async () => {
		const { screen } = await mountEditorFixture('前文');
		await editorToolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await page.getByRole('combobox').fill('tsx');
		await page.getByRole('option', { name: 'tsx' }).click();
		await expect.poll(() => readSaved(screen.container)).toContain('```tsx');
		// reopen: the close-path reset means the search box starts empty again
		await editorToolbar().getByRole('button', { name: '代码块' }).click();
		await expect.element(page.getByRole('dialog')).toBeInTheDocument();
		await expect.poll(searchBoxValue).toBe('');
	});
});

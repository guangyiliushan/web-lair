import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import FileDropzoneFixture from './file-dropzone.fixture.svelte';

/**
 * Pins the drop-in picker the admin media uploader is built on. The whole
 * surface is the click target (`role="button"`), so a missing `drop` handler
 * silently degrades to "the browser navigates away to the dropped file" — the
 * failure this suite exists to catch.
 */

function dropzone(): HTMLElement {
	const el = document.querySelector('[data-slot="file-dropzone"]');
	if (!(el instanceof HTMLElement)) throw new Error('dropzone not rendered');
	return el;
}

function input(): HTMLInputElement {
	const el = document.querySelector<HTMLInputElement>('input[type="file"]');
	if (!el) throw new Error('hidden file input not rendered');
	return el;
}

function emitted(): string {
	return document.querySelector('[data-testid="emitted"]')?.textContent ?? '';
}

function fileOf(name: string, type = 'image/png'): File {
	return new File([new Uint8Array(4)], name, { type });
}

function dropOn(el: HTMLElement, files: File[]): void {
	const dataTransfer = new DataTransfer();
	for (const file of files) dataTransfer.items.add(file);
	el.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
}

async function mount(props: { accept?: string; disabled?: boolean; multiple?: boolean } = {}) {
	return render(FileDropzoneFixture, props);
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('file dropzone', () => {
	it('renders its content and a labelled button surface', async () => {
		await mount();
		expect(dropzone().getAttribute('role')).toBe('button');
		expect(dropzone().getAttribute('aria-label')).toBe('Spec dropzone');
		expect(dropzone().textContent).toContain('Drop files here');
		expect(dropzone().textContent).toContain('or click to browse');
	});

	it('reports dropped files and stops the event from reaching a page handler', async () => {
		await mount();
		const pageHandler = vi.fn();
		window.addEventListener('drop', pageHandler);

		dropOn(dropzone(), [fileOf('a.png'), fileOf('b.png')]);
		await tick();

		expect(emitted()).toBe('a.png,b.png');
		expect(pageHandler).not.toHaveBeenCalled();
		window.removeEventListener('drop', pageHandler);
	});

	it('reports a file picked through the input and resets it for a re-pick', async () => {
		await mount();
		const picker = input();
		const chosen = fileOf('a.png');

		// The picker owns the input: install the files, then fire the change it listens for.
		Object.defineProperty(picker, 'files', { value: [chosen], configurable: true });
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		await tick();

		expect(emitted()).toBe('a.png');
		expect(picker.value).toBe('');
	});

	it('opens the picker on click and on Enter/Space', async () => {
		const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
		await mount();

		dropzone().click();
		dropzone().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		dropzone().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		expect(click).toHaveBeenCalledTimes(3);
	});

	it('neither opens the picker nor reports files while disabled', async () => {
		const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
		await mount({ disabled: true });

		expect(dropzone().getAttribute('aria-disabled')).toBe('true');
		dropzone().click();
		dropzone().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		dropOn(dropzone(), [fileOf('a.png')]);
		await tick();

		expect(click).not.toHaveBeenCalled();
		expect(emitted()).toBe('');
	});
});

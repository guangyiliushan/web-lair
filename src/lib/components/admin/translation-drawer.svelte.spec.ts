import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import TranslationDrawer from './translation-drawer.svelte';

/**
 * Browser specs for the translation drawer. The state table is copy: one
 * primary per state, so each case pins the primary by its label (and by the
 * `bg-primary` fill only the primary variant carries). The preview is the
 * drawer's single rich surface, so a candidate gets exactly one grid and a
 * language without one gets none. `open-target` needs a row, so every case
 * without a `targetId` must paint no such action.
 */

overwriteGetLocale(() => 'en');

const source = {
	lang: 'zh-cn',
	content: '# 源文\n\n源文正文的段落。'
};

const candidate = {
	id: '11111111-1111-1111-1111-111111111111',
	targetLang: 'ja',
	status: 'draft',
	title: '候補',
	content: '# 候補\n\n訳文の段落。',
	error: null
};

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
});

function renderDrawer(props: Record<string, unknown> = {}) {
	return render(TranslationDrawer, {
		open: true,
		lang: 'ja',
		state: 'missing',
		candidate: null,
		source,
		busy: false,
		error: null,
		canRetranslate: false,
		canGenerate: true,
		onAction: () => {},
		...props
	});
}

function primaryButton(): HTMLButtonElement | null {
	return document.querySelector<HTMLButtonElement>('button.bg-primary');
}

describe('translation drawer', () => {
	it('makes retry the primary of a failed generation and shows the error', async () => {
		await renderDrawer({
			state: 'failed',
			candidate: { ...candidate, content: null, error: 'Provider timed out' },
			error: 'Provider timed out'
		});
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Retry');
		expect(document.querySelector('[role="alert"]')?.textContent).toContain('Provider timed out');
		// No candidate body yet, but the source still gets a reading column.
		const preview = document.querySelector('[data-testid="translation-preview"]');
		expect(preview).not.toBeNull();
		expect(preview?.textContent).toContain('Source');
		expect(preview?.textContent).toContain('源文正文的段落。');
		expect(preview?.textContent).not.toContain('Candidate');
	});

	it('makes accept the primary of a candidate and renders one preview grid', async () => {
		await renderDrawer({ state: 'candidate', candidate });
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Accept into draft');
		expect(document.querySelectorAll('[data-testid="translation-preview"]')).toHaveLength(1);
		expect(document.body.textContent).toContain('Source');
		expect(document.body.textContent).toContain('Candidate');
	});

	it('previews the streamed body while the candidate is still generating', async () => {
		await renderDrawer({
			state: 'queued',
			candidate: { ...candidate, content: null, partial: '# 候補\n\n訳文の途中。' }
		});
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Generating…');

		// The model's output is already readable next to the source, under the
		// "Generating…" caption - the row has no final body to show yet.
		const preview = document.querySelector('[data-testid="translation-preview"]');
		expect(preview?.textContent).toContain('訳文の途中。');
		expect(preview?.textContent).toContain('Generating…');
	});

	it('disables the primary while queued and keeps the source-only preview', async () => {
		await renderDrawer({ state: 'queued', candidate: { ...candidate, content: null } });
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Generating…');
		expect(primaryButton()?.disabled).toBe(true);
		// A queued candidate exists without a body; the source is all there is.
		const preview = document.querySelector('[data-testid="translation-preview"]');
		expect(preview).not.toBeNull();
		expect(preview?.textContent).toContain('Source');
		expect(preview?.textContent).toContain('源文正文的段落。');
		expect(preview?.textContent).not.toContain('Candidate');
	});

	it('explains a parked row instead of pretending it is generating', async () => {
		await renderDrawer({
			state: 'queued',
			candidate: { ...candidate, content: null },
			stage: 'waiting',
			waitingReason: 'Rate limited (429)'
		});
		await expect
			.poll(() => document.body.textContent ?? '')
			.toContain('Waiting to retry (Rate limited (429))');
		// Still a wait, not a finished run: the primary stays disabled.
		expect(primaryButton()?.disabled).toBe(true);
	});

	it('offers generate for a missing language and previews the source alone', async () => {
		const onAction = vi.fn();
		await renderDrawer({ state: 'missing', onAction });
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Generate candidate');
		expect(document.querySelector('[data-testid="translation-preview"]')?.className).toContain(
			'md:grid-cols-1'
		);
		const primary = primaryButton();
		expect(primary).not.toBeNull();
		if (primary) await userEvent.click(primary);
		expect(onAction).toHaveBeenCalledWith('generate');
	});

	it('offers retranslate beside open-target for a draft and confirms the overwrite', async () => {
		const onAction = vi.fn();
		await renderDrawer({
			state: 'draft',
			targetId: candidate.id,
			canRetranslate: true,
			onAction
		});
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Open target');

		const again = page.getByRole('button', { name: 'Translate again' });
		await expect.element(again).toBeEnabled();
		await again.click();

		// The request replaces text that already exists, so the click alone must
		// not fire it: the dialog names the language and waits for the operator.
		expect(onAction).not.toHaveBeenCalled();
		await expect
			.element(page.getByRole('alertdialog'))
			.toHaveTextContent('Translate again and overwrite the ja draft?');
		await page.getByRole('button', { name: 'Overwrite and translate' }).click();
		expect(onAction).toHaveBeenCalledWith('retranslate');
		// The answer was given: the dialog must not linger while the request runs.
		await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument();
	});

	it('hides retranslate when the language has no draft to replace', async () => {
		// A published or private row is refused by the service, so the button
		// must not exist; the candidate keeps its own overflow.
		await renderDrawer({ state: 'candidate', candidate, canRetranslate: false });
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Accept into draft');

		await page.getByRole('button', { name: 'Actions' }).click();
		await expect.element(page.getByRole('menuitem', { name: 'Discard' })).toBeEnabled();
		await expect
			.element(page.getByRole('button', { name: 'Translate again' }))
			.not.toBeInTheDocument();
	});

	it('hides open-target for a candidate whose language has no row yet', async () => {
		await renderDrawer({ state: 'candidate', candidate });
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Accept into draft');
		expect(document.body.textContent).not.toContain('Open target');
	});

	it('paints no primary for a draft the drawer cannot open', async () => {
		await renderDrawer({ state: 'draft' });
		expect(primaryButton()).toBeNull();
	});

	it("surfaces a candidate's stored error even without an editor error", async () => {
		// The editor passes `drawerCandidate?.error ?? drawerError`; a reload
		// that only re-reads the candidate must still explain the failure.
		await renderDrawer({
			state: 'failed',
			candidate: { ...candidate, content: null, error: 'Provider timed out' },
			error: null
		});
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Retry');
		expect(document.querySelector('[role="alert"]')?.textContent).toContain('Provider timed out');
	});

	it('offers the empty editor beside the AI request for an empty language', async () => {
		const onAction = vi.fn();
		await renderDrawer({ state: 'empty', targetId: candidate.id, onAction });
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Generate candidate');

		const open = page.getByRole('button', { name: 'Open target' });
		await expect.element(open).toBeEnabled();
		await open.click();
		expect(onAction).toHaveBeenCalledWith('open-target');
	});

	it('refuses to generate while the source has no published body', async () => {
		await renderDrawer({
			state: 'missing',
			canGenerate: false,
			source: { ...source, content: null }
		});
		await expect.poll(() => primaryButton()?.textContent ?? '').toContain('Generate candidate');
		expect(primaryButton()?.disabled).toBe(true);
		expect(document.body.textContent).toContain(
			'Publish the source first — translation reads the published body'
		);
		// Copying an empty source would only create an empty translation row.
		expect(document.body.textContent).not.toContain('Copy source text');
	});
});

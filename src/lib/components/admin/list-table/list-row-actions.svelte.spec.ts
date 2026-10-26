import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ListRowActionsFixture from './list-row-actions.fixture.svelte';

/**
 * `primary` is additive, not exclusive.
 *
 * It used to replace the edit button, which forced friends to hand-roll its own
 * flex box around a status action *and* the shared component. Rendering it in
 * front of the slots keeps the files list unchanged (it passes no `editLabel`)
 * while letting a row carry both. These assertions are what keeps that from
 * regressing either way.
 */

function labels(): string[] {
	return [...document.querySelectorAll('button, a')]
		.map((el) => el.getAttribute('aria-label') || el.textContent?.trim() || '')
		.filter(Boolean);
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('list row actions', () => {
	it('keeps the edit button when a primary control is present', async () => {
		render(ListRowActionsFixture, { edit: true });

		expect(document.querySelector('[data-testid="extra"]')).not.toBeNull();
		expect(labels()).toContain('Edit');
		expect(labels()).toContain('Delete');
	});

	it('renders no edit button when the caller has none (files)', async () => {
		render(ListRowActionsFixture, { edit: false });

		expect(document.querySelector('[data-testid="extra"]')).not.toBeNull();
		expect(labels()).not.toContain('Edit');
		expect(labels()).toContain('Delete');
	});
});

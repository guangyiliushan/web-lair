import { afterEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import MarkdownRenderer from '$lib/components/markdown/editor/MarkdownRenderer.svelte';

// Browser-project spec: the tabs enhancement upgrades the no-JS markup
// (all panels expanded) into an ARIA tablist with keyboard support.

const SOURCE = '::::tabs\n:::tab{label="一"}\n面板甲\n:::\n:::tab{label="二"}\n面板乙\n:::\n::::';

const instances: Array<Record<string, unknown>> = [];

afterEach(() => {
	while (instances.length > 0) {
		unmount(instances.pop() as never);
	}
});

async function mountTabs(): Promise<HTMLElement> {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const instance = mount(MarkdownRenderer, { target: host, props: { source: SOURCE } });
	instances.push(instance as never);
	await new Promise((resolve) => setTimeout(resolve, 0));
	return host;
}

describe('tabs ARIA enhancement (spec 3.2/7)', () => {
	it('provides tablist semantics with the first tab active', async () => {
		const host = await mountTabs();
		const tablist = host.querySelector('[role="tablist"]');
		expect(tablist).not.toBeNull();
		const tabs = host.querySelectorAll('[role="tab"]');
		expect(tabs.length).toBe(2);
		const panels = host.querySelectorAll('[role="tabpanel"]');
		expect(panels.length).toBe(2);
		expect(tabs[0].getAttribute('aria-selected')).toBe('true');
		expect(tabs[1].getAttribute('aria-selected')).toBe('false');
		expect((panels[0] as HTMLElement).hidden).toBe(false);
		expect((panels[1] as HTMLElement).hidden).toBe(true);
		expect(tabs[0].getAttribute('aria-controls')).toBe(panels[0].id);
		expect(panels[0].getAttribute('aria-labelledby')).toBe(tabs[0].id);
	});

	it('switches panels on click and on arrow keys', async () => {
		const host = await mountTabs();
		const tabs = host.querySelectorAll<HTMLElement>('[role="tab"]');
		const panels = host.querySelectorAll<HTMLElement>('[role="tabpanel"]');
		tabs[1].click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(tabs[1].getAttribute('aria-selected')).toBe('true');
		expect(panels[0].hidden).toBe(true);
		expect(panels[1].hidden).toBe(false);
		// ArrowLeft from the second tab wraps back to the first
		tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(tabs[0].getAttribute('aria-selected')).toBe('true');
		expect(panels[1].hidden).toBe(true);
		expect(tabs[0].tabIndex).toBe(0);
	});

	it('supports Home and End keys', async () => {
		const host = await mountTabs();
		const labels = host.querySelectorAll<HTMLElement>('[role="tab"]');
		labels[0].focus();
		labels[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(labels[1].getAttribute('aria-selected')).toBe('true');
		labels[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(labels[0].getAttribute('aria-selected')).toBe('true');
	});
});

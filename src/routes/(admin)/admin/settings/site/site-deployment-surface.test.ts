import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Site page shows deployment facts and nothing else.
 * `site-deployment.test.ts` covers the load payload; this pins the rendered
 * surface - the four read-only rows and NO TLS/ACME/certificate/domain input.
 * The page is source-inspected because the defect class is "a control quietly
 * came back", which a happy-path render test would not catch.
 */
const PAGE = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

function section(from: string, to: string): string {
	const start = PAGE.indexOf(from);
	expect(start, `section marker not found: ${from}`).toBeGreaterThan(-1);
	const end = PAGE.indexOf(to, start);
	return PAGE.slice(start, end === -1 ? undefined : end);
}

describe('Site deployment surface', () => {
	const deployment = section('<!-- Deployment', '<!-- Search indexing').replace(
		/<!--[\s\S]*?-->/g,
		''
	);

	it('renders ORIGIN, admin path, NODE_ENV and version from the load payload', () => {
		expect(deployment).toContain('data.deployment.origin');
		expect(deployment).toContain('data.deployment.adminPath');
		expect(deployment).toContain('data.deployment.environment');
		expect(deployment).toContain('data.deployment.version');
	});

	it('has no input control, form or Save button in the deployment block', () => {
		expect(deployment).not.toContain('<Input');
		expect(deployment).not.toContain('<input');
		expect(deployment).not.toContain('<SettingsForm');
		expect(deployment).not.toContain('type="submit"');
	});

	it('offers no TLS / certificate / ACME / domain editor', () => {
		expect(deployment.toLowerCase()).not.toContain('certificate');
		expect(deployment.toLowerCase()).not.toContain('acme');
		expect(deployment).not.toMatch(/name="(?:tls|acme|domain|cert)/);
		// The explanatory copy lives in the section description, not a control.
		expect(deployment).toContain('m.admin_settings_site_deployment_hint()');
	});

	it('does not resurrect the URL / keyword fields deleted by S1-S8', () => {
		for (const field of ['adminUrl', 'apiUrl', 'gatewayUrl', 'keywords', 'lightIcon', 'darkIcon']) {
			expect(PAGE).not.toContain(`name="${field}"`);
		}
	});
});

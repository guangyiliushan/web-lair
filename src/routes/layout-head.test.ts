import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the root `<head>`: every page (home included — it has no `SeoHead`)
 * carries the icon link with its version bust, the manifest link and
 * `og:site_name`. All three live in the root layout so they cannot drift apart
 * between routes.
 */
const LAYOUT = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');

describe('root layout head', () => {
	it('derives the icon href from site.icon with the bundled fallback', () => {
		expect(LAYOUT).toContain('siteIconHref(data.siteIcon, favicon)');
		expect(LAYOUT).toContain('<link rel="icon" href={iconHref} />');
	});

	it('advertises the manifest', () => {
		expect(LAYOUT).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
	});

	it('emits og:site_name from the layout branding', () => {
		expect(LAYOUT).toContain('<meta property="og:site_name" content={data.siteName} />');
	});
});

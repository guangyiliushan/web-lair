import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * W5.3 acceptance on the root head: every page (home included - the home
 * route has no SeoHead) must carry the icon link with the version bust, the
 * manifest link, and og:site_name. The home page's `<head>` is the concrete
 * curl target in G5, so this lives in the root layout rather than SeoHead;
 * the source guard keeps the three tags together.
 */
const LAYOUT = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');

describe('root layout head (W5.3)', () => {
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

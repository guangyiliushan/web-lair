import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import SocialRail from './SocialRail.svelte';

overwriteGetLocale(() => 'en');

function anchors(): HTMLAnchorElement[] {
	return [...document.querySelectorAll('[data-slot="social-rail-hero"] a')] as HTMLAnchorElement[];
}

describe('SocialRail', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('renders the owner links in order and appends RSS exactly once', async () => {
		await render(SocialRail, {
			links: [
				{ platform: 'github', href: 'https://github.com/guang' },
				{ platform: 'email', href: 'mailto:me@example.com' }
			],
			variant: 'hero'
		});

		const hrefs = anchors().map((anchor) => anchor.getAttribute('href') ?? '');
		expect(hrefs.slice(0, 2)).toEqual(['https://github.com/guang', 'mailto:me@example.com']);
		// siteHref localizes the feed route (`/en/rss.xml` on the default locale).
		expect(hrefs[2]).toMatch(/(^|\/)rss\.xml$/);
		expect(hrefs.filter((href) => href.endsWith('/rss.xml'))).toHaveLength(1);
	});

	it('opens external links in a new tab but keeps mailto/RSS local', async () => {
		await render(SocialRail, {
			links: [
				{ platform: 'github', href: 'https://github.com/guang' },
				{ platform: 'email', href: 'mailto:me@example.com' }
			],
			variant: 'hero'
		});

		const [github, email, rss] = anchors();
		expect(github.getAttribute('target')).toBe('_blank');
		expect(github.getAttribute('rel')).toBe('noopener noreferrer');
		expect(email.getAttribute('target')).toBeNull();
		expect(rss.getAttribute('target')).toBeNull();
	});

	it('still renders the fixed RSS entry when the owner has no links', async () => {
		await render(SocialRail, { links: [], variant: 'hero' });

		const hrefs = anchors().map((anchor) => anchor.getAttribute('href') ?? '');
		expect(hrefs).toHaveLength(1);
		expect(hrefs[0]).toMatch(/(^|\/)rss\.xml$/);
	});
});

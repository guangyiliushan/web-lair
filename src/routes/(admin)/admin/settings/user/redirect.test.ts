import { describe, expect, it } from 'vitest';
import { load } from './+page.server';

describe('/admin/settings/user redirect', () => {
	it('permanently redirects to the Profile & Preferences route', async () => {
		const thrown = (await (async () => {
			try {
				await load({} as never);
			} catch (caught) {
				return caught;
			}
		})()) as { status: number; location: string };
		expect(thrown.status).toBe(308);
		expect(thrown.location).toBe('/admin/settings/profile');
	});
});

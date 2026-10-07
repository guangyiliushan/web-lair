import { describe, expect, it } from 'vitest';
import {
	PROJECT_PROVIDERS,
	PROJECT_PROVIDER_LABEL_KEYS,
	PROJECT_STATUSES,
	PROJECT_STATUS_LABEL_KEYS,
	PROJECT_SYNC_PROVIDERS,
	isProjectProvider,
	isProjectStatus,
	isProjectSyncProvider
} from './project-meta';

/**
 * Pins the UI-facing projects metadata (S batch): the constants match the
 * plan whitelists and the i18n key maps are frozen so the admin surface and
 * the public grid cannot diverge on key names. The CHECK-literal side is
 * pinned separately by `enum-drift.test.ts`.
 */
describe('project meta', () => {
	it('lists the six providers and the four-platform sync subset', () => {
		expect(PROJECT_PROVIDERS).toEqual(['github', 'gitlab', 'gitee', 'bitbucket', 'site', 'other']);
		expect(PROJECT_SYNC_PROVIDERS).toEqual(['github', 'gitlab', 'gitee', 'bitbucket']);
		for (const provider of PROJECT_SYNC_PROVIDERS) {
			expect(PROJECT_PROVIDERS).toContain(provider);
		}
		expect(PROJECT_STATUSES).toEqual(['pending', 'published', 'hidden', 'rejected']);
	});

	it('maps the four statuses to the admin label keys', () => {
		expect(PROJECT_STATUS_LABEL_KEYS).toEqual({
			pending: 'admin_projects_status_pending',
			published: 'admin_projects_status_published',
			hidden: 'admin_projects_status_hidden',
			rejected: 'admin_projects_status_rejected'
		});
	});

	it('maps provider labels: brands render literally, site/other via i18n keys', () => {
		expect(PROJECT_PROVIDER_LABEL_KEYS).toEqual({
			github: null,
			gitlab: null,
			gitee: null,
			bitbucket: null,
			site: 'projects_badge_site',
			other: 'projects_badge_other'
		});
	});

	it('type guards accept every whitelist member and reject everything else', () => {
		for (const provider of PROJECT_PROVIDERS) expect(isProjectProvider(provider)).toBe(true);
		for (const provider of PROJECT_SYNC_PROVIDERS)
			expect(isProjectSyncProvider(provider)).toBe(true);
		for (const status of PROJECT_STATUSES) expect(isProjectStatus(status)).toBe(true);
		expect(isProjectProvider('GitHub')).toBe(false);
		expect(isProjectSyncProvider('site')).toBe(false);
		expect(isProjectStatus('draft')).toBe(false);
	});
});

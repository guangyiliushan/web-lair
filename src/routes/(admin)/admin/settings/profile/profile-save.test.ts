import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the W4.1 profile form: the owner/pointer gate decides
 * whether the page renders inputs, the action re-checks the role before it
 * touches the service, social rows are parsed into the service shape and
 * typed validation failures surface as 400/409 form errors (never a crash).
 */
const { serviceState, guardMock } = vi.hoisted(() => ({
	serviceState: {
		view: {
			profile: {
				userId: 'owner-1',
				displayName: 'guangyiliushan',
				headerLabel: 'guang' as string | null,
				avatarUrl: null as string | null,
				links: null as { platform: string; href: string }[] | null
			},
			email: 'owner@example.com',
			pointerUserId: 'owner-1' as string | null
		},
		saveError: null as Error | null,
		saved: null as unknown
	},
	guardMock: vi.fn(async () => {})
}));

vi.mock('$lib/server/authz', () => ({ requireAdminRole: guardMock }));
vi.mock('$lib/server/services/owner-profile', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/services/owner-profile')>();
	return {
		...actual,
		loadOwnerEditorView: vi.fn(async () => serviceState.view),
		saveOwnerProfile: vi.fn(async (input: unknown, options: unknown) => {
			if (serviceState.saveError) throw serviceState.saveError;
			serviceState.saved = { input, options };
			return {
				userId: 'owner-1',
				displayName: 'guangyiliushan',
				headerLabel: 'shan',
				avatarUrl: null,
				links: null
			};
		})
	};
});

import { actions, load } from './+page.server';
import { OwnerProfileError } from '$lib/server/services/owner-profile';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

overwriteGetLocale(() => 'zh-cn');

function makeEvent(
	fields: Record<string, string | string[]>,
	role: 'owner' | 'admin' = 'owner',
	userId = 'owner-1'
) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
	}
	return {
		request: new Request('http://x/admin/settings/profile?/save', {
			method: 'POST',
			body
		}),
		locals: { user: { id: userId }, admin: { userId, role } }
	};
}

function callSave(event: ReturnType<typeof makeEvent>) {
	return (actions as unknown as Record<string, (event: never) => Promise<unknown>>)['save'](
		event as never
	);
}

describe('profile settings route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serviceState.saveError = null;
		serviceState.saved = null;
		serviceState.view.pointerUserId = 'owner-1';
		serviceState.view.profile.headerLabel = 'guang';
	});

	it('marks the page editable only for the pointer owner', async () => {
		await expect(load(makeEvent({}) as never)).resolves.toMatchObject({ editable: true });

		serviceState.view.pointerUserId = 'someone-else';
		await expect(load(makeEvent({}) as never)).resolves.toMatchObject({ editable: false });

		serviceState.view.pointerUserId = 'owner-1';
		await expect(load(makeEvent({}, 'admin', 'admin-1') as never)).resolves.toMatchObject({
			editable: false
		});
	});

	it('re-checks the admin guard and owner tier before saving', async () => {
		await expect(
			callSave(
				makeEvent(
					{
						displayName: 'guangyiliushan',
						headerLabel: 'guang',
						avatarUrl: '',
						linkPlatform: '',
						linkHref: ''
					},
					'admin',
					'admin-1'
				)
			)
		).rejects.toMatchObject({ status: 403 });
		expect(guardMock).toHaveBeenCalled();
		expect(serviceState.saved).toBeNull();
	});

	it('parses display name, label, avatar and ordered social rows', async () => {
		const result = await callSave(
			makeEvent({
				displayName: 'guangyiliushan',
				headerLabel: 'shan',
				avatarUrl: 'https://example.com/a.png',
				linkPlatform: ['github', 'email', ''],
				linkHref: ['https://github.com/guang', 'mailto:me@example.com', ''],
				linkLabel: ['', '', '']
			})
		);

		expect(result).toMatchObject({ step: 'profile', ok: true });
		expect(serviceState.saved).toEqual({
			input: {
				displayName: 'guangyiliushan',
				headerLabel: 'shan',
				avatarUrl: 'https://example.com/a.png',
				links: [
					{ platform: 'github', href: 'https://github.com/guang' },
					{ platform: 'email', href: 'mailto:me@example.com' }
				]
			},
			options: { actorId: 'owner-1' }
		});
	});

	it('surfaces typed validation failures as form errors', async () => {
		serviceState.saveError = new OwnerProfileError(
			'header_label_invalid',
			'Header label must be 1-6 characters.',
			400
		);

		const result = await callSave(makeEvent({ displayName: 'x', headerLabel: 'abcdefg' }));

		expect(result).toMatchObject({
			status: 400,
			data: { step: 'profile', ok: false, message: 'Header label must be 1-6 characters.' }
		});
	});

	it('maps pointer mismatches to 409', async () => {
		serviceState.saveError = new OwnerProfileError(
			'owner_pointer_mismatch',
			'This profile belongs to a different owner.',
			409
		);

		const result = await callSave(makeEvent({ displayName: 'x' }));

		expect(result).toMatchObject({ status: 409, data: { step: 'profile', ok: false } });
	});
});

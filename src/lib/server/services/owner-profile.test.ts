import { describe, expect, it } from 'vitest';
import {
	loadOwnerProfile,
	ownerProfileToSiteOwner,
	type OwnerProfileReadExecutor
} from './owner-profile';

type Row = {
	userId: string;
	userName: string;
	userImage: string | null;
	displayName: string | null;
	headerLabel: string | null;
	avatarUrl: string | null;
	links: { platform: string; href: string }[] | null;
};

function executorReturning(rows: Row[]): OwnerProfileReadExecutor {
	const chain = {
		from: () => chain,
		innerJoin: () => chain,
		leftJoin: () => chain,
		where: () => chain,
		limit: async () => rows
	};
	return { select: () => chain } as unknown as OwnerProfileReadExecutor;
}

const ROW: Row = {
	userId: 'owner-1',
	userName: 'Full Name',
	userImage: 'https://example.com/auth.png',
	displayName: 'Public Name',
	headerLabel: 'shan',
	avatarUrl: 'https://example.com/avatar.png',
	links: [{ platform: 'github', href: 'https://github.com/example' }]
};

describe('loadOwnerProfile', () => {
	it('maps the pointer join and prefers user_profiles over the auth user', async () => {
		await expect(loadOwnerProfile(executorReturning([ROW]))).resolves.toEqual({
			userId: 'owner-1',
			displayName: 'Public Name',
			headerLabel: 'shan',
			avatarUrl: 'https://example.com/avatar.png',
			links: ROW.links
		});
	});

	it('falls back to the auth user when the profile row is missing (left join)', async () => {
		await expect(
			loadOwnerProfile(
				executorReturning([
					{
						...ROW,
						displayName: null,
						headerLabel: null,
						avatarUrl: null,
						links: null
					}
				])
			)
		).resolves.toMatchObject({
			displayName: 'Full Name',
			avatarUrl: 'https://example.com/auth.png',
			headerLabel: null,
			links: null
		});
	});

	it('returns null when no owner pointer matches (caller uses SITE_OWNER_DEFAULT)', async () => {
		await expect(loadOwnerProfile(executorReturning([]))).resolves.toBeNull();
	});
});

describe('ownerProfileToSiteOwner', () => {
	it('keeps the full name as the identity and maps an empty avatar to ""', () => {
		expect(
			ownerProfileToSiteOwner({
				userId: 'owner-1',
				displayName: 'Public Name',
				headerLabel: 'shan',
				avatarUrl: null,
				links: null
			})
		).toEqual({ name: 'Public Name', avatar: '' });
	});
});

import { describe, expect, it } from 'vitest';
import {
	countGraphemes,
	loadOwnerProfile,
	normalizeAvatarUrl,
	normalizeDisplayName,
	normalizeHeaderLabel,
	normalizeHomeHeroInput,
	normalizeLinks,
	OwnerProfileError,
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
		).toEqual({ name: 'Public Name', avatar: '', headerLabel: 'shan' });
	});
});

describe('grapheme counting (header label budget)', () => {
	it.each([
		['shan', 4],
		['mikoto', 6],
		['山田', 2],
		['👨‍👩‍👧‍👦', 1],
		['🇯🇵', 1],
		['👍🏽', 1]
	])('%s counts as %i', (value, count) => {
		expect(countGraphemes(value)).toBe(count);
	});
});

describe('owner profile validation', () => {
	it('normalizes the display name and header label', () => {
		expect(normalizeDisplayName('  guangyiliushan  ')).toBe('guangyiliushan');
		expect(normalizeHeaderLabel('')).toBeNull();
		expect(normalizeHeaderLabel('  shan ')).toBe('shan');
		expect(normalizeHeaderLabel('mikoto')).toBe('mikoto');
	});

	it('rejects an empty/overlong display name and an overlong label', () => {
		expect(() => normalizeDisplayName('   ')).toThrowError(OwnerProfileError);
		expect(() => normalizeDisplayName('x'.repeat(81))).toThrowError(OwnerProfileError);
		expect(() => normalizeHeaderLabel('abcdefg')).toThrowError(/1-6/);
		expect(() => normalizeHeaderLabel('two words')).toThrowError(/single word/);
	});

	it('allows only https or /i/ avatars', () => {
		expect(normalizeAvatarUrl('')).toBeNull();
		expect(normalizeAvatarUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
		expect(normalizeAvatarUrl('/i/abc.png')).toBe('/i/abc.png');
		expect(() => normalizeAvatarUrl('http://example.com/a.png')).toThrowError(/https/);
		expect(() => normalizeAvatarUrl('javascript:alert(1)')).toThrowError(/https/);
		expect(() => normalizeAvatarUrl('/i/../secret')).toThrowError(/not valid/);
	});

	it('enforces the social preset hosts, max 8 and https/mailto', () => {
		expect(
			normalizeLinks([
				{ platform: 'github', href: 'https://github.com/example' },
				{ platform: 'email', href: 'mailto:me@example.com' }
			])
		).toHaveLength(2);
		expect(() =>
			normalizeLinks([{ platform: 'github', href: 'https://example.com/example' }])
		).toThrowError(/host/);
		expect(() =>
			normalizeLinks([{ platform: 'github', href: 'http://github.com/example' }])
		).toThrowError(/https/);
		expect(() =>
			normalizeLinks([{ platform: 'mastodon', href: 'https://example.com/@x' }])
		).toThrowError(/Unknown social platform/);
		expect(() =>
			normalizeLinks([
				{ platform: 'github', href: 'https://github.com/example' },
				{ platform: 'github', href: 'https://github.com/example' }
			])
		).toThrowError(/Duplicate/);
		const tooMany = Array.from({ length: 9 }, (_, i) => ({
			platform: 'github',
			href: `https://github.com/example${i}`
		}));
		expect(() => normalizeLinks(tooMany)).toThrowError(/At most 8/);
	});

	it('keeps only supported hero locales and drops empty overrides', () => {
		expect(
			normalizeHomeHeroInput({
				title: { en: ' Hi, I am {name} ', 'zh-cn': '', ja: 'こんにちは' },
				description: { en: 'x'.repeat(300) }
			})
		).toEqual({
			title: { en: 'Hi, I am {name}', ja: 'こんにちは' },
			subtitlePrefix: {},
			subtitleHighlight: {},
			description: { en: 'x'.repeat(300) },
			welcome: {}
		});
		expect(() => normalizeHomeHeroInput({ title: { fr: 'salut' } })).toThrowError(
			/Unsupported locale/
		);
		expect(() => normalizeHomeHeroInput({ title: { en: 'x'.repeat(121) } })).toThrowError(
			/too long/
		);
	});

	it('tags input errors as 400 (pointer errors are 409 in the integration suite)', () => {
		const error = (() => {
			try {
				normalizeDisplayName('');
			} catch (caught) {
				return caught as OwnerProfileError;
			}
		})();
		expect(error?.status).toBe(400);
	});
});

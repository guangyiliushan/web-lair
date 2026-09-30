import { redirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route-level tests for the posts/[slug] comment actions (comment P3a,
 * spec §10): the session + verification gates, server-side target resolution
 * from the URL slug via the service resolver (client-supplied ids are
 * ignored) and the result-kind to localized-failure mapping. The service
 * module is mocked with call recording so guard order and payloads have
 * teeth (P1.1 route-test pattern).
 */
const { state } = vi.hoisted(() => {
	const state = {
		user: null as null | {
			id: string;
			name: string;
			emailVerified: boolean;
			image: string | null;
		},
		profile: null as null | { displayName: string | null; avatarUrl: string | null },
		resolveResult: 'post-1' as string | null,
		resolveCalls: [] as unknown[][],
		submitCalls: [] as Record<string, unknown>[],
		submitResults: [] as { kind: string }[]
	};
	return { state };
});

vi.mock('$lib/server/db', () => ({
	db: { select: () => ({}) }
}));
vi.mock('$lib/server/authz', () => ({
	requireUser: () => {
		if (!state.user) redirect(303, '/login?redirectTo=%2Fen%2Fposts%2Fp3a-post');
		return state.user;
	}
}));
vi.mock('$lib/server/services/comments', () => ({
	loadThreads: vi.fn(),
	resolveCommentPostTarget: vi.fn(async (...args: unknown[]) => {
		state.resolveCalls.push(args);
		return state.resolveResult;
	}),
	submitComment: vi.fn(async (input: Record<string, unknown>) => {
		state.submitCalls.push(input);
		return state.submitResults.shift() ?? { kind: 'created', id: 'c1', state: 'pending' };
	})
}));
vi.mock('$lib/paraglide/runtime', () => ({
	getLocale: () => 'en',
	localizeHref: (href: string) => href,
	locales: ['en', 'zh-cn', 'ja']
}));
vi.mock('$lib/paraglide/messages', () => ({
	m: new Proxy({}, { get: (_target, prop) => () => String(prop) })
}));
vi.mock('$lib/server/markdown', () => ({ renderMarkdownToHtml: vi.fn(async () => '') }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { actions } from './+page.server';
import { resolveCommentPostTarget } from '$lib/server/services/comments';

const resolveMock = vi.mocked(resolveCommentPostTarget);
const commentAction = actions.comment as (event: never) => Promise<Record<string, unknown>>;
const replyAction = actions.reply as (event: never) => Promise<Record<string, unknown>>;

function fd(fields: Record<string, string>): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) form.set(key, value);
	return form;
}

function makeEvent(form: FormData, slug = 'p3a-post') {
	return {
		locals: { user: state.user, profile: state.profile },
		params: { slug },
		url: new URL(`http://localhost/en/posts/${slug}`),
		request: new Request(`http://localhost/en/posts/${slug}`, { method: 'POST', body: form })
	} as never;
}

beforeEach(() => {
	state.user = { id: 'u1', name: 'Alice', emailVerified: true, image: null };
	state.profile = null;
	state.resolveResult = 'post-1';
	state.resolveCalls = [];
	state.submitCalls = [];
	state.submitResults = [];
	resolveMock.mockClear();
});

describe('post comment actions', () => {
	it('redirects guests to the login page with the return path', async () => {
		state.user = null;
		await expect(commentAction(makeEvent(fd({ text: 'hi' })))).rejects.toMatchObject({
			status: 303,
			location: '/login?redirectTo=%2Fen%2Fposts%2Fp3a-post'
		});
	});

	it('blocks unverified readers before resolution or submit', async () => {
		state.user = { id: 'u1', name: 'Alice', emailVerified: false, image: null };
		const result = await commentAction(makeEvent(fd({ text: 'hi' })));
		expect(result).toMatchObject({ status: 403, data: { message: 'comment_verify_hint' } });
		expect(resolveMock).not.toHaveBeenCalled();
		expect(state.submitCalls).toHaveLength(0);
	});

	it('resolves the target through the service resolver and freezes the snapshot', async () => {
		state.profile = { displayName: 'Dee', avatarUrl: 'https://cdn.example/a.png' };
		const result = await commentAction(makeEvent(fd({ text: 'hello' })));
		expect(result).toEqual({ submitted: 'pending' });
		// One shared timestamp for resolution + submit: both must agree.
		expect(state.resolveCalls[0]?.[0]).toBe('en');
		expect(state.resolveCalls[0]?.[1]).toBe('p3a-post');
		expect(state.resolveCalls[0]?.[2]).toBeInstanceOf(Date);
		expect(state.submitCalls[0]).toMatchObject({
			targetType: 'post',
			targetId: 'post-1',
			lang: 'en',
			parentId: null,
			text: 'hello',
			author: 'Dee',
			avatar: 'https://cdn.example/a.png',
			now: expect.any(Date)
		});
	});

	it('ignores a parentId smuggled into the comment action but reads it for reply', async () => {
		await commentAction(makeEvent(fd({ text: 'x', parentId: 'evil-id' })));
		expect(state.submitCalls[0].parentId).toBeNull();

		await replyAction(makeEvent(fd({ text: 'y', parentId: 'good-id' })));
		expect(state.submitCalls[1].parentId).toBe('good-id');
	});

	it('fails closed when the slug does not resolve for this locale', async () => {
		state.resolveResult = null;
		const result = await commentAction(makeEvent(fd({ text: 'hi' })));
		expect(result).toMatchObject({ status: 404, data: { message: 'comment_error_unavailable' } });
		expect(state.submitCalls).toHaveLength(0);
	});

	it('maps every service result kind to the localized failure', async () => {
		const cases: Array<[string, number, string]> = [
			['throttled', 429, 'comment_throttled'],
			['unverified', 403, 'comment_verify_hint'],
			['parent-unavailable', 400, 'comment_error_parent'],
			['target-unavailable', 404, 'comment_error_unavailable'],
			['empty', 400, 'comment_error_generic'],
			['too-long', 400, 'comment_error_generic'],
			['unsupported-target', 400, 'comment_error_generic']
		];
		for (const [kind, status, message] of cases) {
			state.submitResults = [{ kind }];
			const result = await commentAction(makeEvent(fd({ text: 'hi' })));
			expect(result, kind).toMatchObject({ status, data: { message } });
		}
	});
});

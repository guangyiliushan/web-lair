import { describe, expect, it } from 'vitest';
import { drawerStateFor, queuedPresentation, type DrawerState } from './translation-drawer-state';

type Presence = Record<string, { status: string; hasContent: boolean }>;

type Candidate = {
	targetLang: string;
	status: string;
	content: string | null;
	error: string | null;
};

const row = (status: string, hasContent: boolean) => ({ status, hasContent });

const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
	targetLang: 'zh-cn',
	status: 'draft',
	content: null,
	error: null,
	...overrides
});

type DrawerCase = {
	name: string;
	lang: string;
	presence: Presence;
	candidates: Candidate[];
	expected: DrawerState;
};

/**
 * One case per state, plus the statuses that must not produce one. The drawer
 * and the language ruler both read this function, so the table is the contract
 * that keeps them from disagreeing.
 */
const cases: DrawerCase[] = [
	{
		name: 'no row and no candidate is missing',
		lang: 'zh-cn',
		presence: {},
		candidates: [],
		expected: 'missing'
	},
	{
		name: 'a row without content is empty',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('draft', false) },
		candidates: [],
		expected: 'empty'
	},
	{
		name: 'a draft candidate without content is queued',
		lang: 'zh-cn',
		presence: {},
		candidates: [candidate()],
		expected: 'queued'
	},
	{
		name: 'a whitespace-only candidate body is still queued',
		lang: 'zh-cn',
		presence: {},
		candidates: [candidate({ content: ' \n\t ' })],
		expected: 'queued'
	},
	{
		name: 'a draft candidate with content is candidate',
		lang: 'zh-cn',
		presence: {},
		candidates: [candidate({ content: '你好' })],
		expected: 'candidate'
	},
	{
		name: 'a candidate with an error is failed',
		lang: 'zh-cn',
		presence: {},
		candidates: [candidate({ error: 'provider down' })],
		expected: 'failed'
	},
	{
		name: 'an error wins over a body that was already generated',
		lang: 'zh-cn',
		presence: {},
		candidates: [candidate({ content: '你好', error: 'provider down' })],
		expected: 'failed'
	},
	{
		name: 'a draft row with content is draft',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('draft', true) },
		candidates: [],
		expected: 'draft'
	},
	{
		name: 'a private row with content reads as draft',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('private', true) },
		candidates: [],
		expected: 'draft'
	},
	{
		name: 'a published row is published',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('published', true) },
		candidates: [],
		expected: 'published'
	},
	{
		name: 'a scheduled row reads as published',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('scheduled', true) },
		candidates: [],
		expected: 'published'
	},
	{
		name: 'a published row wins before its content is consulted',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('published', false) },
		candidates: [],
		expected: 'published'
	},
	{
		name: 'a discarded candidate is ignored and the row decides',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('published', true) },
		candidates: [candidate({ status: 'discarded', error: 'provider down' })],
		expected: 'published'
	},
	{
		name: 'an accepted candidate is ignored and the row decides',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('draft', true) },
		candidates: [candidate({ status: 'accepted', content: '你好' })],
		expected: 'draft'
	},
	{
		name: 'a discarded candidate does not mask an older draft candidate',
		lang: 'zh-cn',
		presence: {},
		candidates: [
			candidate({ status: 'discarded', error: 'provider down' }),
			candidate({ content: '你好' })
		],
		expected: 'candidate'
	},
	{
		name: 'a candidate for another language is ignored',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('draft', true) },
		candidates: [candidate({ targetLang: 'ja', content: 'こんにちは' })],
		expected: 'draft'
	},
	{
		name: 'the newest candidate decides when it has content',
		lang: 'zh-cn',
		presence: {},
		candidates: [candidate({ content: '新' }), candidate({ error: '旧失败' })],
		expected: 'candidate'
	},
	{
		name: 'the newest candidate decides when it failed',
		lang: 'zh-cn',
		presence: {},
		candidates: [candidate({ error: '新失败' }), candidate({ content: '旧' })],
		expected: 'failed'
	},
	{
		name: 'a pending candidate outranks a published row',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('published', true) },
		candidates: [candidate({ content: '你好' })],
		expected: 'candidate'
	},
	{
		name: 'a queued candidate outranks a draft row with content',
		lang: 'zh-cn',
		presence: { 'zh-cn': row('draft', true) },
		candidates: [candidate()],
		expected: 'queued'
	},
	{
		name: 'the requested language picks its own row and candidates',
		lang: 'ja',
		presence: { 'zh-cn': row('published', true), ja: row('draft', false) },
		candidates: [candidate({ targetLang: 'zh-cn', content: '你好' })],
		expected: 'empty'
	}
];

describe('drawerStateFor', () => {
	it.each(cases)('$name', ({ lang, presence, candidates, expected }) => {
		expect(drawerStateFor({ lang, presence, candidates })).toBe(expected);
	});
});

describe('queuedPresentation', () => {
	it.each([
		{
			name: 'a parked row explains why it stopped',
			input: { stage: 'waiting', waitingReason: 'rate limit exceeded', runningSinceSec: 12 },
			expected: 'waiting'
		},
		{
			name: 'a parked row with no reason falls back to the claim state',
			input: { stage: 'waiting', waitingReason: null, runningSinceSec: 12 },
			expected: 'running'
		},
		{
			name: 'a claimed row is generating',
			input: { stage: 'body', waitingReason: null, runningSinceSec: 12 },
			expected: 'running'
		},
		{
			name: 'an unclaimed row waits for a worker',
			input: { stage: null, waitingReason: null, runningSinceSec: null },
			expected: 'pending'
		},
		{
			name: 'a parked row that no worker touched still explains why',
			input: { stage: 'waiting', waitingReason: 'AI budget paused', runningSinceSec: null },
			expected: 'waiting'
		}
	] as const)('$name', ({ input, expected }) => {
		expect(queuedPresentation(input)).toBe(expected);
	});
});

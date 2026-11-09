import { describe, expect, it } from 'vitest';
import {
	LEDGER_DEFAULTS,
	dayKey,
	ledgerSearch,
	parseLedgerQuery,
	rangeStart,
	toConsoleMessage,
	toConsoleMessages
} from './console-view';

/**
 * The console reads `ai_agent_messages.content` as loose jsonb, so the mapping
 * is where every optional shape is decided. These cases pin the fallbacks the
 * transcript relies on (no trace UI for legacy rows, no crash on junk).
 */
describe('AI console view model', () => {
	it('flattens text, trace steps and citations from the jsonb payload', () => {
		const message = toConsoleMessage({
			id: 'm1',
			seq: 3,
			role: 'assistant',
			model: 'gpt-x',
			createdAt: '2026-11-01T02:00:00.000Z',
			content: {
				text: 'Hello',
				trace: [
					{ title: 'lexical search', description: '12 chunks', status: 'running' },
					{ title: 'build context' }
				],
				citations: [{ title: 'PCA overview', description: 'note:a1b2', href: '/admin/notes/1' }]
			}
		});

		expect(message.text).toBe('Hello');
		expect(message.role).toBe('assistant');
		expect(message.model).toBe('gpt-x');
		expect(message.trace).toEqual([
			{ title: 'lexical search', description: '12 chunks', status: 'running' },
			{ title: 'build context', description: null, status: 'pending' }
		]);
		expect(message.citations).toEqual([
			{ title: 'PCA overview', description: 'note:a1b2', href: '/admin/notes/1' }
		]);
	});

	it('falls back to a system role and an empty transcript row', () => {
		const message = toConsoleMessage({
			id: 'm2',
			seq: 0,
			role: 'narrator',
			model: null,
			createdAt: null,
			content: null
		});

		expect(message.role).toBe('system');
		expect(message.text).toBe('');
		expect(message.trace).toEqual([]);
		expect(message.citations).toEqual([]);
	});

	it('accepts a bare string payload and drops malformed entries', () => {
		const [plain, junk] = toConsoleMessages([
			{
				id: 'm3',
				seq: 1,
				role: 'user',
				model: null,
				createdAt: null,
				content: 'plain text'
			},
			{
				id: 'm4',
				seq: 2,
				role: 'assistant',
				model: null,
				createdAt: null,
				content: {
					text: '   ',
					trace: [null, 'nope', { title: '' }, { title: 'kept' }],
					citations: [{}, { title: 'only title' }]
				}
			}
		]);

		expect(plain.text).toBe('plain text');
		expect(junk.text).toBe('');
		expect(junk.trace).toEqual([{ title: 'kept', description: null, status: 'pending' }]);
		expect(junk.citations).toEqual([{ title: 'only title', description: null, href: null }]);
	});

	it('buckets rows by local calendar day', () => {
		expect(dayKey('2026-11-01T10:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(dayKey(null)).toBe('');
		expect(dayKey('not a date')).toBe('');
	});
});

/**
 * Ledger filters round-trip through the URL. A stale or hand-edited query
 * string must degrade to the default view rather than throw or render an
 * empty table that looks like "no data".
 */
describe('ledger query', () => {
	it('defaults when the query is empty', () => {
		expect(parseLedgerQuery(new URLSearchParams())).toEqual(LEDGER_DEFAULTS);
	});

	it('keeps recognised values', () => {
		const parsed = parseLedgerQuery(
			new URLSearchParams('view=summary&range=90d&task=translation&status=failure&provider=openai')
		);
		expect(parsed).toEqual({
			view: 'summary',
			range: '90d',
			task: 'translation',
			status: 'failure',
			provider: 'openai',
			relatedType: '',
			relatedId: ''
		});
	});

	it('falls back on values that are not in the domain', () => {
		const parsed = parseLedgerQuery(
			new URLSearchParams('view=chat&range=forever&task=drop-table&status=maybe')
		);
		expect(parsed).toEqual(LEDGER_DEFAULTS);
	});

	it('treats an over-long provider token as absent', () => {
		expect(parseLedgerQuery(new URLSearchParams(`provider=${'x'.repeat(65)}`)).provider).toBe('');
		expect(parseLedgerQuery(new URLSearchParams('provider=  openai  ')).provider).toBe('openai');
	});

	it('omits defaults from the shared URL and restores them on parse', () => {
		expect(ledgerSearch({})).toBe('');
		expect(ledgerSearch({ range: '7d', task: 'summary' })).toBe('?range=7d&task=summary');
		const round = parseLedgerQuery(
			new URLSearchParams(ledgerSearch({ range: '7d', task: 'summary' }))
		);
		expect(round.range).toBe('7d');
		expect(round.task).toBe('summary');
		expect(round.view).toBe('activity');
	});

	it('drops columns the user cleared instead of pinning them', () => {
		expect(ledgerSearch({ range: '30d', task: '', status: '', provider: '' })).toBe('');
	});
});

describe('rangeStart', () => {
	// Built in local time and read back in local time: `setDate` works on the
	// local calendar, so asserting on an ISO string would make this test pass
	// in UTC and fail west of it.
	const now = new Date(2026, 10, 3);
	const localDay = (date: Date) =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
			date.getDate()
		).padStart(2, '0')}`;

	it('has no lower bound for the all-time range', () => {
		expect(rangeStart('all', now)).toBeNull();
	});

	it('steps back the right number of days', () => {
		expect(localDay(rangeStart('7d', now)!)).toBe('2026-10-27');
		expect(localDay(rangeStart('30d', now)!)).toBe('2026-10-04');
		expect(localDay(rangeStart('90d', now)!)).toBe('2026-08-05');
	});
});

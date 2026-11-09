/**
 * Read-side view model for the AI console.
 *
 * `ai_agent_messages.content` is deliberately loose jsonb (see MessageContent),
 * so every optional field is narrowed here instead of inside components. The
 * module stays free of Svelte state: mapping is unit-testable and shared by the
 * server load payload and the transcript UI.
 */

export type AiMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type TraceStatus = 'running' | 'pending' | 'error';

export interface ConsoleTraceStep {
	title: string;
	description: string | null;
	status: TraceStatus;
}

export interface ConsoleCitation {
	title: string;
	description: string | null;
	href: string | null;
}

export interface ConsoleMessage {
	id: string;
	seq: number;
	role: AiMessageRole;
	text: string;
	model: string | null;
	createdAt: Date | string | null;
	trace: ConsoleTraceStep[];
	citations: ConsoleCitation[];
}

export interface ConsoleConversation {
	id: string;
	title: string | null;
	summary: string | null;
	archivedAt: Date | string | null;
	createdAt: Date | string | null;
	updatedAt: Date | string | null;
	messageCount: number;
}

/** Shape of one row from `ai_agent_messages` as it reaches the console. */
export interface ConsoleMessageRow {
	id: string;
	seq: number;
	role: string;
	content: unknown;
	model: string | null;
	createdAt: Date | string | null;
}

const ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool']);
const STATUSES: ReadonlySet<string> = new Set(['running', 'pending', 'error']);

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function asText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? value : null;
}

export function asRole(value: string): AiMessageRole {
	return ROLES.has(value) ? (value as AiMessageRole) : 'system';
}

function toTrace(value: unknown): ConsoleTraceStep[] {
	if (!Array.isArray(value)) return [];
	const steps: ConsoleTraceStep[] = [];
	for (const entry of value) {
		const record = asRecord(entry);
		const title = asText(record.title);
		if (!title) continue;
		const status =
			typeof record.status === 'string' && STATUSES.has(record.status)
				? (record.status as TraceStatus)
				: 'pending';
		steps.push({ title, description: asText(record.description), status });
	}
	return steps;
}

function toCitations(value: unknown): ConsoleCitation[] {
	if (!Array.isArray(value)) return [];
	const citations: ConsoleCitation[] = [];
	for (const entry of value) {
		const record = asRecord(entry);
		const title = asText(record.title);
		if (!title) continue;
		citations.push({
			title,
			description: asText(record.description),
			href: asText(record.href)
		});
	}
	return citations;
}

/** Flattens one message row into everything the transcript knows how to draw. */
export function toConsoleMessage(row: ConsoleMessageRow): ConsoleMessage {
	const content = asRecord(row.content);
	return {
		id: row.id,
		seq: row.seq,
		role: asRole(row.role),
		text: asText(content.text) ?? asText(row.content) ?? '',
		model: row.model,
		createdAt: row.createdAt,
		trace: toTrace(content.trace),
		citations: toCitations(content.citations)
	};
}

export function toConsoleMessages(rows: ConsoleMessageRow[]): ConsoleMessage[] {
	return rows.map(toConsoleMessage);
}

function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Local calendar day, used to decide where a transcript marker belongs. */
export function dayKey(value: Date | string | null | undefined): string {
	const date = toDate(value);
	if (!date) return '';
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDay(value: Date | string | null | undefined, locale: string): string {
	const date = toDate(value);
	if (!date) return '—';
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	}).format(date);
}

export function formatTime(value: Date | string | null | undefined, locale: string): string {
	const date = toDate(value);
	if (!date) return '';
	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(date);
}

export function formatDateTime(value: Date | string | null | undefined, locale: string): string {
	const date = toDate(value);
	if (!date) return '—';
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(date);
}

export function formatNumber(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	return value.toLocaleString();
}

export function formatCost(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	return value.toFixed(4);
}

// ── Activity ledger query ──────────────────────────────────────────────
// Filter state lives in the URL so a filtered ledger can be reloaded, shared
// and linked into. Anything unrecognised falls back to the default instead of
// erroring: a stale bookmark should still open a page.

export type LedgerView = 'activity' | 'summary';
export type LedgerRange = '7d' | '30d' | '90d' | 'all';

export const LEDGER_VIEWS: readonly LedgerView[] = ['activity', 'summary'];
export const LEDGER_RANGES: readonly LedgerRange[] = ['7d', '30d', '90d', 'all'];

/** Mirrors the `ai_usage_task_check` constraint - keep the two in step. */
export const LEDGER_TASKS = [
	'summary',
	'translation',
	'translation_review',
	'comment_review',
	'chat',
	'assistant',
	'editor',
	'transcription',
	'other'
] as const;

/** Mirrors the `ai_usage_status_check` constraint. */
export const LEDGER_STATUSES = ['success', 'failure'] as const;

/**
 * Content kinds a call can be attributed to. Same closed set the ledger writes
 * (`related_type`), so a "usage for this post" link cannot ask for a kind no
 * row ever has.
 */
export const LEDGER_RELATED_TYPES = ['post', 'note'] as const;
export type LedgerRelatedType = (typeof LEDGER_RELATED_TYPES)[number];

export interface LedgerFilters {
	view: LedgerView;
	range: LedgerRange;
	/** Empty string means "every task" / "every status" / "every provider". */
	task: string;
	status: string;
	provider: string;
	/**
	 * Scope to one content row. Both must be present to filter: a type without
	 * an id would silently match nothing, which reads like "no usage" instead of
	 * "broken link".
	 */
	relatedType: LedgerRelatedType | '';
	relatedId: string;
}

export const LEDGER_DEFAULTS: LedgerFilters = {
	view: 'activity',
	range: '30d',
	task: '',
	status: '',
	provider: '',
	relatedType: '',
	relatedId: ''
};

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
	return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Provider names are operator data, not an enum: only the shape is checked. */
function providerToken(value: string | null): string {
	if (!value) return '';
	return value.length <= 64 ? value.trim() : '';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLedgerQuery(params: URLSearchParams): LedgerFilters {
	// A malformed pair collapses to "no scope" rather than a filter that matches
	// nothing: the alternative is a page that looks empty for no visible reason.
	const relatedType = oneOf(params.get('relatedType'), LEDGER_RELATED_TYPES, '' as const);
	const relatedId = (params.get('relatedId') ?? '').trim();
	const scoped = relatedType !== '' && UUID_PATTERN.test(relatedId);
	return {
		view: oneOf(params.get('view'), LEDGER_VIEWS, LEDGER_DEFAULTS.view),
		range: oneOf(params.get('range'), LEDGER_RANGES, LEDGER_DEFAULTS.range),
		task: oneOf(params.get('task'), LEDGER_TASKS, LEDGER_DEFAULTS.task),
		status: oneOf(params.get('status'), LEDGER_STATUSES, LEDGER_DEFAULTS.status),
		provider: providerToken(params.get('provider')),
		relatedType: scoped ? relatedType : '',
		relatedId: scoped ? relatedId : ''
	};
}

/**
 * Query string with the defaults left out, so shared URLs stay short.
 * `extra` carries non-filter state like the open detail row.
 */
export function ledgerSearch(
	filters: Partial<LedgerFilters>,
	extra: Record<string, string> = {}
): string {
	const params = new URLSearchParams();
	const merged = { ...LEDGER_DEFAULTS, ...filters };
	if (merged.view !== LEDGER_DEFAULTS.view) params.set('view', merged.view);
	if (merged.range !== LEDGER_DEFAULTS.range) params.set('range', merged.range);
	if (merged.task) params.set('task', merged.task);
	if (merged.status) params.set('status', merged.status);
	if (merged.provider) params.set('provider', merged.provider);
	if (merged.relatedType && merged.relatedId) {
		params.set('relatedType', merged.relatedType);
		params.set('relatedId', merged.relatedId);
	}
	for (const [key, value] of Object.entries(extra)) {
		if (value) params.set(key, value);
	}
	const query = params.toString();
	return query ? `?${query}` : '';
}

const RANGE_DAYS: Record<Exclude<LedgerRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** Lower bound for a range, or `null` when the range covers everything. */
export function rangeStart(range: LedgerRange, now: Date): Date | null {
	if (range === 'all') return null;
	const start = new Date(now);
	start.setDate(start.getDate() - RANGE_DAYS[range]);
	return start;
}

/**
 * Compact stamp for the ledger's time column (`11-03 14:32`). Fixed numeric
 * order on purpose: an audit column wants one shape and tabular figures, not a
 * locale phrase that changes width per language.
 */
export function formatStamp(value: Date | string | null | undefined): string {
	const date = toDate(value);
	if (!date) return '—';
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
		date.getMinutes()
	)}`;
}

/**
 * Where a ledger row's related content lives. Returns `null` for anything the
 * admin cannot open, so the cell shows plain text instead of a dead link.
 *
 * Deliberately not `comment`: the comment queue has no per-row anchor yet, and
 * a link that lands somewhere unrelated is worse than no link.
 */
export function relatedHref(
	relatedType: string | null | undefined,
	relatedId: string | null | undefined
): string | null {
	if (!relatedType || !relatedId) return null;
	if (relatedType === 'post') return `/admin/posts/edit?id=${relatedId}`;
	if (relatedType === 'note') return `/admin/notes/edit?id=${relatedId}`;
	return null;
}

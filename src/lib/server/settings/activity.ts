import { desc, eq, like, or } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activities } from '$lib/server/db/system';
import { user } from '$lib/server/db/auth.schema';

/**
 * Settings change history.
 *
 * One read over `activities` for the settings event families. Payloads are
 * redacted before they leave the server: a future provider test may include a
 * token-shaped key even though today's settings events do not, and the view
 * must be safe by construction rather than by convention.
 */
export const SETTINGS_EVENT_FAMILIES = [
	'profile',
	'home',
	'site',
	'storage',
	'comments',
	'friends',
	'presence',
	'notes_gate',
	'privacy',
	'mail',
	'webhook',
	'account',
	'ai'
] as const;

export type SettingsEventFamily = (typeof SETTINGS_EVENT_FAMILIES)[number];

export interface SettingsActivity {
	id: string;
	event: string;
	actorName: string | null;
	payload: Record<string, unknown> | null;
	createdAt: Date;
}

export type SettingsActivityExecutor = Pick<typeof db, 'select'>;

const SECRET_KEY =
	/(secret|token|password|ciphertext|private_key|api_key|access_key|authorization)/i;
const SAFE_META_KEY = /^(fields|key_version)$/i;

/** Deep-redact secret-shaped object keys; arrays and nesting are preserved. */
export function redactAuditPayload(payload: unknown): Record<string, unknown> | null {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
	const redact = (value: unknown, key?: string): unknown => {
		if (key && SECRET_KEY.test(key) && !SAFE_META_KEY.test(key)) return '[redacted]';
		if (Array.isArray(value)) return value.map((item) => redact(item));
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
					childKey,
					redact(child, childKey)
				])
			);
		}
		return value;
	};
	return redact(payload) as Record<string, unknown>;
}

function formatValue(value: unknown, maxLength = 80): string {
	if (value === undefined || value === null) return '—';
	const text = typeof value === 'string' ? value : JSON.stringify(value);
	if (!text) return '—';
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** `payload.fields` + before/after → a compact, redacted diff. */
export function auditChanges(
	payload: Record<string, unknown> | null
): Array<{ field: string; before: string; after: string }> {
	if (!payload) return [];
	const fields = Array.isArray(payload.fields)
		? payload.fields.filter((field): field is string => typeof field === 'string')
		: [];
	const before =
		payload.before && typeof payload.before === 'object'
			? (payload.before as Record<string, unknown>)
			: {};
	const after =
		payload.after && typeof payload.after === 'object'
			? (payload.after as Record<string, unknown>)
			: {};
	return fields.map((field) => ({
		field,
		before: formatValue(before[field]),
		after: formatValue(after[field])
	}));
}

export async function listSettingsActivity(options: {
	family?: string | null;
	limit?: number;
	executor?: SettingsActivityExecutor;
}): Promise<SettingsActivity[]> {
	const requested = options.family?.trim() || '';
	const family = (SETTINGS_EVENT_FAMILIES as readonly string[]).includes(requested)
		? requested
		: null;
	const families = family ? [family] : SETTINGS_EVENT_FAMILIES;
	const filters = families.map((prefix) => like(activities.event, `${prefix}.%`));
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
	const executor = options.executor ?? db;
	const rows = await executor
		.select({
			id: activities.id,
			event: activities.event,
			actorName: user.name,
			payload: activities.payload,
			createdAt: activities.createdAt
		})
		.from(activities)
		.leftJoin(user, eq(user.id, activities.actorId))
		.where(or(...filters))
		.orderBy(desc(activities.createdAt))
		.limit(limit);
	return rows.map((row) => ({
		id: row.id,
		event: row.event,
		actorName: row.actorName ?? null,
		payload: redactAuditPayload(row.payload),
		createdAt: row.createdAt
	}));
}

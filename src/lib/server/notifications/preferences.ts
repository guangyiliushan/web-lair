import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { options } from '../db/config/option.schema.ts';
import { NOTIFICATION_EVENTS, type NotificationEventType } from './events.ts';
import type { NotificationChannel } from '../db/system/notification-delivery.schema.ts';

/**
 * Notification preferences: one options row (`notifications.preferences`)
 * holds three per-group channel switches. Defaults are the register's:
 * comment and job alerts go out by email, Bark is OFF for every group until
 * the operator turns it on (a phone push is louder and costlier — opt-in,
 * never the default), and the ops group (resource and mail probes) is
 * email-on because a disk at 85% is exactly the alert nobody should poll for.
 * This module is the SINGLE definition: the options registry reuses the zod
 * schema and defaults, and the drain reads the row through the same parser.
 * It is Node-strip-loadable on purpose (relative `.ts` imports, no `$lib`),
 * because the drain evaluates the preferences on every tick. A missing or
 * invalid row yields the defaults (logged once) — a hand-edited option must
 * not stop deliveries.
 */
export const NOTIFICATION_PREFERENCES_OPTION = 'notifications.preferences';

export const NOTIFICATION_GROUPS = ['comment', 'job', 'ops'] as const;
export type NotificationGroupName = (typeof NOTIFICATION_GROUPS)[number];

const groupSchema = z.object({
	email: z.boolean(),
	bark: z.boolean()
});

export const notificationPreferencesSchema = z.object({
	comment: groupSchema,
	job: groupSchema,
	ops: groupSchema
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
	comment: { email: true, bark: false },
	job: { email: true, bark: false },
	ops: { email: true, bark: false }
};

/**
 * Structural DB seam (same pattern as `secrets/resolver.ts`): only a single
 * `select ... where ... limit(1)` is needed, and both the app db and a drain
 * transaction satisfy it. Call sites cast their drizzle client once.
 */
interface PreferenceSelect {
	where(condition: unknown): Promise<Array<{ value: unknown }>> & {
		limit(count: number): Promise<Array<{ value: unknown }>>;
	};
}
export interface NotificationPreferenceDb {
	select(fields: { value: unknown }): { from(table: unknown): PreferenceSelect };
}

/** Parse a stored value; anything invalid falls back to the defaults. */
export function parseNotificationPreferences(value: unknown): NotificationPreferences {
	if (value === null || value === undefined)
		return structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
	const parsed = notificationPreferencesSchema.safeParse(value);
	if (parsed.success) return parsed.data;
	console.warn('[notify] notifications.preferences failed validation; using the defaults');
	return structuredClone(DEFAULT_NOTIFICATION_PREFERENCES);
}

/** Read the preferences row (missing row => defaults). Never throws on shape. */
export async function readNotificationPreferences(
	db: NotificationPreferenceDb
): Promise<NotificationPreferences> {
	const rows = await db
		.select({ value: options.value })
		.from(options)
		.where(eq(options.name, NOTIFICATION_PREFERENCES_OPTION))
		.limit(1);
	return parseNotificationPreferences(rows[0]?.value);
}

/** Which of an event's channels the operator has enabled. */
export function enabledChannels(
	eventType: NotificationEventType,
	preferences: NotificationPreferences
): NotificationChannel[] {
	const definition = NOTIFICATION_EVENTS[eventType];
	const group = preferences[definition.group];
	return definition.channels.filter((channel) => group[channel]);
}

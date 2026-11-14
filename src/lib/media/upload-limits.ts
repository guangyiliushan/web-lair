/**
 * Upload limits that are CODE-OWNED (ST5/ST10): they do not follow the storage
 * provider and are not editable from settings. They live outside
 * `services/files.ts` so read-only admin pages can render them without pulling
 * the media service (and its db imports) into their module graph.
 */
export const UPLOAD_RATE_LIMIT = { limit: 60, windowSeconds: 10 * 60 } as const;

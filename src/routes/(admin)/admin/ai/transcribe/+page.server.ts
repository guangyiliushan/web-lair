import { fail } from '@sveltejs/kit';
import { desc } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { transcripts } from '$lib/server/db/ai';
import { requireAiUse } from '$lib/server/authz';
import { recordAiUsage } from '$lib/server/ai/usage';
import { rejectedUpload, transcribeAudio } from '$lib/server/ai/transcribe';
import { getCache } from '$lib/server/cache';
import { rateLimitStrict } from '$lib/server/cache/store';
import { requestAddress } from '$lib/server/security/request-address';
import { clientAddressKey } from '$lib/utils/cidr';
import type { Actions, PageServerLoad } from './$types';

/** Cost-bearing endpoint: 20 transcriptions/hour, 40 per IP. */
const TRANSCRIBE_RATE_LIMIT = { limit: 20, windowSeconds: 60 * 60 } as const;
const TRANSCRIBE_IP_RATE_LIMIT = { limit: 40, windowSeconds: 60 * 60 } as const;

export const load: PageServerLoad = async () => {
	await requireAiUse();
	const recent = await db
		.select({
			id: transcripts.id,
			createdAt: transcripts.createdAt,
			sourceName: transcripts.sourceName,
			language: transcripts.language,
			durationSeconds: transcripts.durationSeconds
		})
		.from(transcripts)
		.orderBy(desc(transcripts.createdAt))
		.limit(10);
	return { recent };
};

export const actions: Actions = {
	transcribe: async ({ request, locals, getClientAddress, setHeaders }) => {
		await requireAiUse();
		// Fail-closed budget before reading or shipping the audio.
		const userId = locals.user?.id;
		const address = clientAddressKey(requestAddress(getClientAddress));
		const [accountRate, addressRate] = await Promise.all([
			rateLimitStrict(
				getCache(),
				`limits:ai-transcribe:${userId ?? 'anonymous'}`,
				TRANSCRIBE_RATE_LIMIT.limit,
				TRANSCRIBE_RATE_LIMIT.windowSeconds
			),
			rateLimitStrict(
				getCache(),
				`limits:ai-transcribe-ip:${address}`,
				TRANSCRIBE_IP_RATE_LIMIT.limit,
				TRANSCRIBE_IP_RATE_LIMIT.windowSeconds
			)
		]);
		if (!accountRate.allowed || !addressRate.allowed) {
			const unavailable = accountRate.unavailable || addressRate.unavailable;
			setHeaders({
				'retry-after': String(
					Math.max(TRANSCRIBE_RATE_LIMIT.windowSeconds, TRANSCRIBE_IP_RATE_LIMIT.windowSeconds)
				)
			});
			return fail(unavailable ? 503 : 429, {
				error: unavailable ? 'unavailable' : 'rate'
			});
		}
		const form = await request.formData();
		const audio = form.get('audio');
		const languageRaw = form.get('language');
		const language = typeof languageRaw === 'string' ? languageRaw : 'auto';
		if (!(audio instanceof File) || audio.size === 0) {
			return fail(400, { error: 'missing' });
		}
		const rejected = rejectedUpload(audio);
		if (rejected) return fail(400, { error: rejected });

		const actorId = locals.user?.id ?? null;
		const started = performance.now();
		try {
			const result = await transcribeAudio({
				file: audio,
				language,
				getEnv: (name) => env[name]
			});
			const [row] = await db
				.insert(transcripts)
				.values({
					actorId,
					sourceName: audio.name,
					mimeType: audio.type || 'application/octet-stream',
					language: result.language,
					text: result.text,
					vtt: result.vtt,
					durationSeconds: result.durationSeconds,
					provider: result.provider,
					model: result.model
				})
				.returning({ id: transcripts.id, createdAt: transcripts.createdAt });

			await recordAiUsage(db, {
				task: 'transcription',
				provider: result.provider,
				model: result.model,
				actorId,
				trigger: 'manual',
				inputTokens: null,
				outputTokens: null,
				costEstimate: null,
				relatedType: 'transcript',
				relatedId: row.id,
				status: 'success',
				durationMs: Math.round(performance.now() - started),
				audioSeconds: result.durationSeconds
			});

			return {
				ok: true,
				id: row.id,
				text: result.text,
				vtt: result.vtt,
				language: result.language,
				durationSeconds: result.durationSeconds
			};
		} catch (caught) {
			const code =
				caught instanceof Error && 'code' in caught ? String(caught.code) : 'bad_response';
			await recordAiUsage(db, {
				task: 'transcription',
				provider: 'whisper',
				model: env.WHISPER_MODEL?.trim() || 'base',
				actorId,
				trigger: 'manual',
				inputTokens: null,
				outputTokens: null,
				costEstimate: null,
				relatedType: 'transcript',
				relatedId: null,
				status: 'failure',
				durationMs: Math.round(performance.now() - started),
				audioSeconds: null
			});
			return fail(502, {
				error: code === 'timeout' || code === 'network' ? 'unavailable' : 'failed'
			});
		}
	}
};

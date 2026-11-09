import { aiUsage } from '../db/ai/ai-usage.schema.ts';
import type { AiDb, AiUsageRecord } from './types.ts';

/**
 * One row per model call (OTel GenAI naming, ledger §14.3). `provider` /
 * `model` are snapshots; a later rename must not rewrite history.
 */
export async function recordAiUsage(db: AiDb, record: AiUsageRecord): Promise<void> {
	try {
		await db.insert(aiUsage).values({
			task: record.task,
			provider: record.provider,
			model: record.model,
			requestedModel: record.requestedModel ?? null,			actorId: record.actorId,
			trigger: record.trigger,
			inputTokens: record.inputTokens,
			outputTokens: record.outputTokens,
			costEstimate: record.costEstimate == null ? null : record.costEstimate.toFixed(6),
			relatedType: record.relatedType,
			relatedId: record.relatedId,
			status: record.status,
			durationMs: record.durationMs,
			audioSeconds: record.audioSeconds ?? null
		});
	} catch (caught) {
		// The ledger must never take down the caller. A failed insert is loud in
		// the log; the provider call has already happened (money spent).
		console.warn(
			'[ai] failed to write ai_usage',
			caught instanceof Error ? caught.message : caught
		);
	}
}

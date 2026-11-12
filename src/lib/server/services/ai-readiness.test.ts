import { describe, expect, it } from 'vitest';
import {
	AI_FUNCTIONS,
	AI_READINESS_STATUSES,
	readinessMessageKeys,
	type AiFunction,
	type AiReadinessStatus
} from '../../utils/ai-meta.ts';
import {
	AI_SETTINGS_ASSIGNMENTS,
	AI_SETTINGS_PROVIDERS,
	AI_WIRED_FUNCTIONS,
	aiReadiness,
	isReady,
	readinessFor,
	type ReadinessInput,
	type ReadinessProvider
} from './ai-readiness.ts';

const OPENAI: ReadinessProvider = {
	name: 'openai',
	enabled: true,
	apiKeyEnv: 'AI_OPENAI_KEY',
	models: ['gpt-4o-mini']
};

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
	return {
		providers: [OPENAI],
		assignments: { translation: { provider: 'openai' } },
		hasEnv: () => true,
		...overrides
	};
}

const ALL_STATUSES: AiReadinessStatus[] = [
	'ready',
	'unassigned',
	'provider_missing',
	'provider_disabled',
	'missing_env',
	'missing_model',
	'not_wired'
];

describe('readinessFor', () => {
	it('is ready when the assignment resolves to an enabled provider with a model and a key', () => {
		const result = readinessFor('translation', input());
		expect(result.status).toBe('ready');
		expect(result.provider).toBe('openai');
		expect(result.model).toBe('gpt-4o-mini');
		expect(result.fix).toBeNull();
		expect(isReady(result)).toBe(true);
	});

	it('is unassigned when the slot has no provider', () => {
		const result = readinessFor('summary', input());
		expect(result.status).toBe('unassigned');
		expect(result.provider).toBeNull();
		expect(result.fix).toEqual({
			href: AI_SETTINGS_ASSIGNMENTS,
			labelKey: 'admin_readiness_fix_assign'
		});
	});

	it('treats a model without a provider as an assignment and reports the missing model', () => {
		// Model-first: the provider is derived, so only the model has to be set.
		// Nothing serves "x" here, which is the actionable answer.
		const result = readinessFor('summary', input({ assignments: { summary: { model: 'x' } } }));
		expect(result.status).toBe('missing_model');
		expect(result.fix?.href).toBe(AI_SETTINGS_PROVIDERS);
	});

	it('is provider_missing when the assigned provider has no row', () => {
		const result = readinessFor(
			'translation',
			input({ assignments: { translation: { provider: 'ghost' } } })
		);
		expect(result.status).toBe('provider_missing');
		expect(result.provider).toBe('ghost');
		expect(result.fix?.href).toBe(AI_SETTINGS_PROVIDERS);
	});

	it('is provider_disabled before it looks at the key or the model', () => {
		const disabled: ReadinessProvider = { ...OPENAI, enabled: false, models: [] };
		const result = readinessFor('translation', {
			providers: [disabled],
			assignments: { translation: { provider: 'openai' } },
			hasEnv: () => {
				throw new Error('hasEnv must not be consulted when the provider is disabled');
			}
		});
		expect(result.status).toBe('provider_disabled');
	});

	it('is missing_env when the key is absent and reports which variable', () => {
		const result = readinessFor('translation', input({ hasEnv: () => false }));
		expect(result.status).toBe('missing_env');
		expect(result.envName).toBe('AI_OPENAI_KEY');
		expect(result.fix?.href).toBe(AI_SETTINGS_PROVIDERS);
	});

	it('is missing_model when neither the assignment nor the provider yields a model', () => {
		const bare: ReadinessProvider = { ...OPENAI, models: [] };
		const result = readinessFor('translation', {
			providers: [bare],
			assignments: { translation: { provider: 'openai' } },
			hasEnv: () => true
		});
		expect(result.status).toBe('missing_model');
		expect(result.model).toBeNull();
	});

	it('is missing_model when the provider list starts with a blank entry', () => {
		// Mirrors resolveProvider: a blank models[0] is not a usable fallback.
		const blank: ReadinessProvider = { ...OPENAI, models: [''] };
		const result = readinessFor('translation', {
			providers: [blank],
			assignments: { translation: { provider: 'openai' } },
			hasEnv: () => true
		});
		expect(result.status).toBe('missing_model');
	});

	it('is not_wired for slots that have a configuration but no caller', () => {
		for (const fn of ['assistant', 'translation_review'] as AiFunction[]) {
			const result = readinessFor(fn, input({ assignments: { [fn]: { provider: 'openai' } } }));
			expect(result.status).toBe('not_wired');
			expect(result.fix).toBeNull();
			expect(isReady(result)).toBe(false);
		}
	});

	it('treats chat as wired, because the agent turn resolves that slot', () => {
		// `agent/run.ts` calls resolveProvider(db, 'chat'): the conversation
		// button is live, so a "not wired" badge next to it would be a lie.
		const assigned = readinessFor('chat', input({ assignments: { chat: { provider: 'openai' } } }));
		expect(assigned.status).toBe('ready');
		expect(isReady(assigned)).toBe(true);

		const unassigned = readinessFor('chat', input());
		expect(unassigned.status).toBe('unassigned');
		expect(unassigned.fix).toEqual({
			href: AI_SETTINGS_ASSIGNMENTS,
			labelKey: 'admin_readiness_fix_assign'
		});
	});
});

describe('model-first resolution', () => {
	const kimi: ReadinessProvider = {
		name: 'kimi',
		enabled: true,
		apiKeyEnv: 'AI_KIMI_KEY',
		models: [{ id: 'shared-model', enabled: true, source: 'manual' }]
	};
	const gateway: ReadinessProvider = {
		name: 'gateway',
		enabled: true,
		apiKeyEnv: 'AI_GATEWAY_KEY',
		models: [{ id: 'shared-model', enabled: true, source: 'manual' }]
	};

	function withProviders(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
		return {
			providers: [kimi, gateway],
			assignments: { translation: { model: 'shared-model' } },
			hasEnv: () => true,
			...overrides
		};
	}

	it('is ready through the first provider that serves the model', () => {
		const result = readinessFor('translation', withProviders());
		expect(result.status).toBe('ready');
		expect(result.provider).toBe('kimi');
		expect(result.model).toBe('shared-model');
	});

	it('falls through to the next provider when the first one lacks its key', () => {
		const result = readinessFor(
			'translation',
			withProviders({ hasEnv: (name) => name !== 'AI_KIMI_KEY' })
		);
		expect(result.status).toBe('ready');
		expect(result.provider).toBe('gateway');
	});

	it('reports the first provider reason when nothing can run', () => {
		const result = readinessFor('translation', withProviders({ hasEnv: () => false }));
		expect(result.status).toBe('missing_env');
		expect(result.envName).toBe('AI_KIMI_KEY');
	});

	it('is missing_model when no provider offers the assigned model', () => {
		const result = readinessFor(
			'translation',
			withProviders({ assignments: { translation: { model: 'ghost-model' } } })
		);
		expect(result.status).toBe('missing_model');
		expect(result.fix?.href).toBe(AI_SETTINGS_PROVIDERS);
	});

	it('ignores a provider that disabled the model', () => {
		const disabledModel: ReadinessProvider = {
			name: 'kimi',
			enabled: true,
			apiKeyEnv: null,
			models: [{ id: 'shared-model', enabled: false, source: 'manual' }]
		};
		const result = readinessFor(
			'translation',
			withProviders({ providers: [disabledModel, gateway] })
		);
		expect(result.status).toBe('ready');
		expect(result.provider).toBe('gateway');
	});

	it('keeps working for a legacy assignment that still names a provider', () => {
		const result = readinessFor(
			'translation',
			withProviders({ assignments: { translation: { provider: 'kimi' } } })
		);
		expect(result.status).toBe('ready');
		expect(result.model).toBe('shared-model');
	});
});

describe('following the default pool', () => {
	const hostA: ReadinessProvider = {
		name: 'kimi',
		enabled: true,
		apiKeyEnv: 'AI_KIMI_KEY',
		models: [{ id: 'shared-model', enabled: true, source: 'manual' }]
	};
	const hostB: ReadinessProvider = {
		name: 'gateway',
		enabled: true,
		apiKeyEnv: 'AI_GATEWAY_KEY',
		models: [{ id: 'shared-model', enabled: true, source: 'manual' }]
	};

	function poolInput(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
		return {
			providers: [hostA, hostB],
			assignments: { translation: {} },
			hasEnv: () => true,
			pool: ['gone-model', 'shared-model'],
			...overrides
		};
	}

	it('reports the first pooled model someone can actually serve', () => {
		const result = readinessFor('translation', poolInput());
		expect(result.status).toBe('ready');
		expect(result.model).toBe('shared-model');
		expect(result.provider).toBe('kimi');
	});

	it('is unassigned when the pool it follows is empty', () => {
		const result = readinessFor('translation', poolInput({ pool: [] }));
		expect(result.status).toBe('unassigned');
		expect(result.fix?.href).toBe(AI_SETTINGS_ASSIGNMENTS);
	});

	it('reports the first reason when nothing in the pool can run', () => {
		const result = readinessFor(
			'translation',
			poolInput({ pool: ['shared-model'], hasEnv: () => false })
		);
		expect(result.status).toBe('missing_env');
		expect(result.model).toBe('shared-model');
	});
});

describe('model fallback', () => {
	it('prefers the assignment model over the provider list', () => {
		const result = readinessFor(
			'translation',
			input({ assignments: { translation: { provider: 'openai', model: 'pinned-snapshot' } } })
		);
		expect(result.model).toBe('pinned-snapshot');
	});

	it('falls back to the first provider model and trims the assignment', () => {
		const result = readinessFor(
			'translation',
			input({ assignments: { translation: { provider: 'openai', model: '   ' } } })
		);
		expect(result.model).toBe('gpt-4o-mini');
	});
});

describe('aiReadiness', () => {
	it('reports every function slot', () => {
		const all = aiReadiness(input());
		expect(Object.keys(all).sort()).toEqual([...AI_FUNCTIONS].sort());
	});

	it('marks exactly the wired slots ready for a fully configured provider', () => {
		const assignments = Object.fromEntries(
			AI_FUNCTIONS.map((fn) => [fn, { provider: 'openai' }])
		) as ReadinessInput['assignments'];
		const all = aiReadiness(input({ assignments }));
		const readySlots = AI_FUNCTIONS.filter((fn) => isReady(all[fn]));
		expect(readySlots.sort()).toEqual([...AI_WIRED_FUNCTIONS].sort());
	});
});

describe('readinessMessageKeys', () => {
	it('keeps the exported status list in step with the pinned contract', () => {
		expect([...AI_READINESS_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
	});

	it('names both a label and a hint for every status', () => {
		for (const status of ALL_STATUSES) {
			const keys = readinessMessageKeys(status);
			expect(keys.label).toBeTruthy();
			expect(keys.hint).toBeTruthy();
			expect(keys.label).not.toBe(keys.hint);
		}
	});

	it('uses distinct keys per status so copy cannot collapse', () => {
		const labels = ALL_STATUSES.map((status) => readinessMessageKeys(status).label);
		expect(new Set(labels).size).toBe(ALL_STATUSES.length);
	});
});

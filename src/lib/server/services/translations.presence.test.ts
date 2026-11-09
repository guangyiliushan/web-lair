import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Row exists" is not "translation exists" (P4 review): a target row left empty
 * by a failed generation must not answer `lang-exists` nor make the publish
 * hook skip that language. These tests pin the READER side of the shared
 * predicate: `requestTranslation` and `enqueueTranslationsAfterPublish` ask
 * `hasUsableTranslation` instead of probing for a row themselves.
 */
const { dbMock, state, presenceMock, enqueueJobMock, getOptionMock } = vi.hoisted(() => ({
	dbMock: {} as Record<string, unknown>,
	state: {
		selectQueue: [] as unknown[][],
		selects: [] as unknown[],
		targetRows: [] as unknown[],
		inserts: [] as { table: unknown; values: Record<string, unknown> }[],
		insertResults: [] as unknown[][]
	},
	presenceMock: vi.fn<
		(sourceType: 'post' | 'note', group: string, lang: string) => Promise<boolean>
	>(async () => false),
	enqueueJobMock: vi.fn(async () => ({ id: 'job-1', deduplicated: false })),
	getOptionMock: vi.fn(async (key: string) => {
		if (key === 'ai.translation') return { minChars: 1, defaultMode: 'auto', notesAuto: false };
		if (key === 'site.languages') return { enabled: ['en', 'zh-cn', 'ja'] };
		throw new Error(`unexpected option ${key}`);
	})
}));

vi.mock('$lib/server/db', () => ({ db: dbMock }));
vi.mock('$lib/server/jobs/queue', () => ({ enqueueJob: enqueueJobMock }));
vi.mock('$lib/server/config/options-registry', () => ({
	getOption: getOptionMock,
	OPTION_LANGS: ['en', 'zh-cn', 'ja']
}));
// Only the hash lands in the inserted row; its own teeth live in ai tests.
vi.mock('$lib/server/ai/translate', () => ({ sourceHash: () => 'source-hash' }));
vi.mock('./translation-presence', () => ({ hasUsableTranslation: presenceMock }));

import { translations } from '$lib/server/db/content';
import { enqueueTranslationsAfterPublish, requestTranslation } from './translations';

const GROUP = 'group-1';

/**
 * The pre-fix reader asked `hasTarget()` "is there a row?" - that probe selects
 * only `{ id }` and is answered by `state.targetRows` (an empty target row).
 * Once the readers use the predicate no such probe is issued; the predicate is
 * mocked because its own teeth live in translation-presence.test.ts.
 */
function isRowProbe(selection: unknown): boolean {
	if (!selection || typeof selection !== 'object') return false;
	const keys = Object.keys(selection);
	return keys.length === 1 && keys[0] === 'id';
}

function makeChain(result: unknown[]) {
	const self: unknown = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === 'then') {
					return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
				}
				return () => self;
			}
		}
	);
	return self;
}

function sourceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'post-1',
		title: 'Source',
		content: 'Plenty of source body content for translation.',
		summary: null,
		lang: 'zh-cn',
		contentFormat: 'markdown',
		categoryId: 'cat-1',
		translationGroup: GROUP,
		translatedFrom: null,
		meta: null,
		status: 'published',
		...overrides
	};
}

beforeEach(() => {
	state.selectQueue = [];
	state.selects = [];
	state.targetRows = [];
	state.inserts = [];
	state.insertResults = [];
	presenceMock.mockReset();
	presenceMock.mockResolvedValue(false);
	enqueueJobMock.mockClear();
	getOptionMock.mockClear();
	dbMock.select = vi.fn((selection: unknown) => {
		state.selects.push(selection);
		if (isRowProbe(selection)) return makeChain(state.targetRows);
		return makeChain(state.selectQueue.shift() ?? []);
	});
	dbMock.insert = vi.fn((table: unknown) => ({
		values: (values: Record<string, unknown>) => {
			state.inserts.push({ table, values });
			return { returning: async () => state.insertResults.shift() ?? [] };
		}
	}));
});

describe('requestTranslation presence', () => {
	it('queues when the target row exists but is empty', async () => {
		state.selectQueue = [[sourceRow()], []];
		state.insertResults = [[{ id: 'translation-1' }]];
		// The row the old helper would have answered with, carrying no content.
		state.targetRows = [{ id: 'post-en' }];

		await expect(
			requestTranslation({ sourceType: 'post', sourceId: 'post-1', targetLang: 'en' })
		).resolves.toEqual({ kind: 'queued', id: 'translation-1' });

		expect(presenceMock).toHaveBeenCalledWith('post', GROUP, 'en');
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].values).toMatchObject({ targetLang: 'en', status: 'draft' });
	});

	it('refuses when the target has content', async () => {
		state.selectQueue = [[sourceRow()]];
		presenceMock.mockResolvedValue(true);

		await expect(
			requestTranslation({ sourceType: 'post', sourceId: 'post-1', targetLang: 'en' })
		).resolves.toEqual({ kind: 'lang-exists' });

		expect(presenceMock).toHaveBeenCalledWith('post', GROUP, 'en');
		expect(state.inserts).toHaveLength(0);
		expect(enqueueJobMock).not.toHaveBeenCalled();
	});
});

describe('enqueueTranslationsAfterPublish presence', () => {
	it('enqueue-after-publish skips only usable languages', async () => {
		const meta = { translate: { mode: 'auto', targets: ['en', 'ja'] } };
		state.selectQueue = [[sourceRow({ meta })], []];
		state.insertResults = [[{ id: 'translation-ja' }]];
		presenceMock.mockImplementation(async (_sourceType, _group, lang) => lang === 'en');

		await enqueueTranslationsAfterPublish('post', 'post-1');

		expect(presenceMock).toHaveBeenCalledWith('post', GROUP, 'en');
		expect(presenceMock).toHaveBeenCalledWith('post', GROUP, 'ja');
		expect(state.inserts).toHaveLength(1);
		expect(state.inserts[0].table).toBe(translations);
		expect(state.inserts[0].values).toMatchObject({ targetLang: 'ja' });
		expect(enqueueJobMock).toHaveBeenCalledTimes(1);
		expect(enqueueJobMock).toHaveBeenCalledWith(dbMock, 'ai.translate', 'manual');
	});
});

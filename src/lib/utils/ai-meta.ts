/**
 * UI-safe AI metadata (no db or server imports): the single source for the
 * provider kinds, the feature slots and their display labels. Server code
 * (options-registry, ai-providers service) reuses the same constants.
 */
export const AI_PROVIDER_KINDS = ['openai-compatible', 'deepl', 'custom'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export const AI_PROVIDER_KIND_LABELS: Record<AiProviderKind, string> = {
	'openai-compatible': 'OpenAI 兼容',
	deepl: 'DeepL',
	custom: '自定义'
};

export const AI_FUNCTIONS = [
	'summary',
	'translation',
	'translation_review',
	'comment_review',
	'chat',
	'assistant'
] as const;
export type AiFunction = (typeof AI_FUNCTIONS)[number];

export const AI_FUNCTION_LABELS: Record<AiFunction, string> = {
	summary: '摘要',
	translation: '翻译',
	translation_review: '翻译审校',
	comment_review: '评论分诊',
	chat: '管理对话',
	assistant: '写作助手'
};

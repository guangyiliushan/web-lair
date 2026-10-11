/**
 * UI-safe AI metadata (no db or server imports): the single source for the
 * provider kinds, the feature slots and their display labels. Server code
 * (options-registry, ai-providers service) reuses the same constants.
 */
export const AI_PROVIDER_KINDS = ['openai-compatible', 'deepl', 'custom'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

type AiLabelLang = 'en' | 'zh-cn' | 'ja';

export const AI_PROVIDER_KIND_LABELS: Record<AiProviderKind, Record<AiLabelLang, string>> = {
	'openai-compatible': { en: 'OpenAI compatible', 'zh-cn': 'OpenAI 兼容', ja: 'OpenAI 互換' },
	deepl: { en: 'DeepL', 'zh-cn': 'DeepL', ja: 'DeepL' },
	custom: { en: 'Custom', 'zh-cn': '自定义', ja: 'カスタム' }
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

export const AI_FUNCTION_LABELS: Record<AiFunction, Record<AiLabelLang, string>> = {
	summary: { en: 'Summary', 'zh-cn': '摘要', ja: '要約' },
	translation: { en: 'Translation', 'zh-cn': '翻译', ja: '翻訳' },
	translation_review: { en: 'Translation review', 'zh-cn': '翻译审校', ja: '翻訳レビュー' },
	comment_review: { en: 'Comment triage', 'zh-cn': '评论分诊', ja: 'コメントトリアージ' },
	chat: { en: 'Chat', 'zh-cn': '管理对话', ja: 'チャット' },
	assistant: { en: 'Writing assistant', 'zh-cn': '写作助手', ja: 'ライティングアシスタント' }
};

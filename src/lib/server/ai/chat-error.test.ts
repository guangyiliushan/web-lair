import { describe, expect, it } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';

// Copy comes from the message catalog; pin the locale so assertions stay in
// sync with the zh-cn catalog (same convention as the other route tests).
overwriteGetLocale(() => 'zh-cn');

import { AiError } from './errors';
import { chatErrorMessage } from './chat-error';

/**
 * Chat failures are written into the transcript, so they are the only
 * explanation the screen ever offers. These cases pin the two halves of that
 * promise: configuration failures name the next step in the operator's
 * language (not the provider's English), and everything else keeps the real
 * message so an actual API error is still debuggable.
 */
describe('chatErrorMessage', () => {
	it('names the settings page when the slot has no model', () => {
		const message = chatErrorMessage(
			new AiError('no_assignment', 'No provider assigned to "chat"')
		);
		expect(message).toBe('对话还没有可用模型。到「AI 设置 › 功能位分配」给「管理对话」指定模型。');
		expect(message).not.toContain('No provider assigned');
	});

	it('covers the other configuration failures with their own copy', () => {
		expect(chatErrorMessage(new AiError('provider_disabled', 'x'))).toContain('服务商已停用');
		expect(chatErrorMessage(new AiError('missing_key', 'x'))).toContain('API 密钥');
		expect(chatErrorMessage(new AiError('unsupported', 'x'))).toContain('OpenAI 兼容');
	});

	it('keeps a real provider failure, wrapped in the shared prefix', () => {
		const message = chatErrorMessage(new AiError('rate_limit', 'Rate limit reached for model'));
		expect(message).toBe('对话失败：Rate limit reached for model');
	});

	it('survives a non-Error throw', () => {
		expect(chatErrorMessage('boom')).toBe('对话失败：boom');
	});
});

import { expect, test } from '@playwright/test';
import { zhCnLocale } from './locale-fixture';

test.use(zhCnLocale);

test('rejects an unsupported upload before calling Whisper', async ({ page }) => {
	await page.goto('/admin/ai/transcribe');
	await expect(page.getByRole('heading', { name: '语音转写' })).toBeVisible({ timeout: 15000 });

	await page.locator('input[name="audio"]').setInputFiles({
		name: 'notes.pdf',
		mimeType: 'application/pdf',
		buffer: Buffer.from('not audio')
	});
	await page.getByRole('button', { name: '开始转写' }).click();
	await expect(page.getByRole('alert')).toHaveText('不支持的文件类型。', { timeout: 15000 });
});

test('transcribes a short clip when the whisper container is running', async ({ page }) => {
	test.skip(!process.env.WHISPER_E2E, 'set WHISPER_E2E=1 with `docker compose up whisper`');
	await page.goto('/admin/ai/transcribe');
	await page.locator('input[name="audio"]').setInputFiles('e2e/fixtures/whisper-sample.wav');
	await page.getByRole('button', { name: '开始转写' }).click();
	await expect(page.getByRole('heading', { name: '转写文本' })).toBeVisible({ timeout: 120000 });
	await expect(page.locator('textarea').first()).toHaveValue(/whisper/i);
});

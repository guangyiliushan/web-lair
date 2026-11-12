import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildVtt, rejectedUpload, transcribeAudio } from './transcribe';

function fakeFile(name: string, type: string, size: number): File {
	return { name, type, size } as File;
}

function audioFile(name = 'a.wav', type = 'audio/wav'): File {
	return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('buildVtt', () => {
	it('writes cue timestamps and escapes markup', () => {
		const vtt = buildVtt(
			[
				{ start: 0, end: 2.5, text: ' hello <world> ' },
				{ start: 2.5, end: 4, text: 'second & line' }
			],
			'fallback'
		);
		expect(vtt).toContain('WEBVTT');
		expect(vtt).toContain('00:00:00.000 --> 00:00:02.500');
		expect(vtt).toContain('hello &lt;world&gt;');
		expect(vtt).toContain('second &amp; line');
	});

	it('falls back to one cue when segments are absent', () => {
		const vtt = buildVtt([], 'plain text');
		expect(vtt).toContain('00:00:00.000 --> 00:00:01.000');
		expect(vtt).toContain('plain text');
	});

	it('returns an empty document for empty input', () => {
		expect(buildVtt([], '  ')).toBe('WEBVTT\n');
	});
});

describe('rejectedUpload', () => {
	it('accepts audio by mime type', () => {
		expect(rejectedUpload(fakeFile('a.bin', 'audio/wav', 10))).toBeNull();
	});

	it('accepts a known extension when the browser sends no mime type', () => {
		expect(rejectedUpload(fakeFile('a.m4a', '', 10))).toBeNull();
	});

	it('rejects oversized and unsupported files', () => {
		expect(rejectedUpload(fakeFile('a.wav', 'audio/wav', 26 * 1024 * 1024))).toBe('too_large');
		expect(rejectedUpload(fakeFile('a.pdf', 'application/pdf', 10))).toBe('bad_type');
	});
});

describe('transcribeAudio', () => {
	it('maps Whisper JSON to text, VTT and duration', async () => {
		const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
			void args;
			return new Response(
				JSON.stringify({
					text: 'hello world',
					language: 'en',
					segments: [{ start: 0, end: 1.2, text: 'hello world' }]
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await transcribeAudio({
			file: audioFile(),
			language: 'auto',
			getEnv: (name) => (name === 'WHISPER_URL' ? 'http://whisper:9000' : undefined)
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0][0])).toContain('/asr?output=json');
		expect(result.text).toBe('hello world');
		expect(result.language).toBe('en');
		expect(result.durationSeconds).toBe(2);
		expect(result.vtt).toContain('00:00:00.000 --> 00:00:01.200');
		expect(result.provider).toBe('whisper');
	});

	it('throws a typed error when Whisper returns an empty transcript', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(JSON.stringify({ text: '', segments: [] }), { status: 200 }))
		);
		await expect(
			transcribeAudio({
				file: audioFile(),
				language: 'auto',
				getEnv: () => 'http://whisper:9000'
			})
		).rejects.toMatchObject({ code: 'invalid_output' });
	});
});

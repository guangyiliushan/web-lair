import { AiError } from './errors';

/**
 * Self-hosted Whisper adapter (whisper-asr-webservice, OpenAI-compatible
 * enough for this one endpoint). Audio is posted as multipart, transcribed,
 * and never written to disk here: the service receives a stream, returns
 * segments, and the caller stores only text + VTT.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 180_000;
const DEFAULT_URL = 'http://127.0.0.1:9100';

const EXTENSIONS = new Set([
	'mp3',
	'm4a',
	'wav',
	'ogg',
	'oga',
	'opus',
	'flac',
	'aac',
	'webm',
	'mp4',
	'mov'
]);

export interface TranscriptionResult {
	text: string;
	vtt: string;
	language: string;
	durationSeconds: number | null;
	provider: string;
	model: string;
}

interface WhisperSegment {
	start?: number;
	end?: number;
	text?: string;
}

interface WhisperResponse {
	text?: string;
	language?: string;
	segments?: WhisperSegment[];
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Returns a message key suffix for rejected uploads, or null when accepted. */
export function rejectedUpload(file: File): 'too_large' | 'bad_type' | null {
	if (file.size <= 0 || file.size > MAX_BYTES) return 'too_large';
	const type = file.type.toLowerCase();
	const extension = extensionOf(file.name);
	if (type.startsWith('audio/')) return null;
	if (type === 'video/mp4' || type === 'video/webm' || type === 'video/quicktime') return null;
	if (!type && EXTENSIONS.has(extension)) return null;
	return 'bad_type';
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, '0');
}

function vttTimestamp(totalSeconds: number): string {
	const seconds = Math.max(0, totalSeconds);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const whole = Math.floor(seconds % 60);
	const millis = Math.round((seconds - Math.floor(seconds)) * 1000);
	return `${pad(hours)}:${pad(minutes)}:${pad(whole)}.${pad(millis, 3)}`;
}

function escapeCue(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function buildVtt(segments: WhisperSegment[], fallbackText: string): string {
	const cues = segments
		.filter(
			(segment) =>
				typeof segment.start === 'number' &&
				typeof segment.end === 'number' &&
				typeof segment.text === 'string' &&
				segment.text.trim().length > 0
		)
		.map((segment) => {
			const start = segment.start as number;
			const end = Math.max(segment.end as number, start + 0.001);
			return `${vttTimestamp(start)} --> ${vttTimestamp(end)}\n${escapeCue(
				(segment.text as string).trim()
			)}`;
		});
	if (cues.length === 0) {
		const text = fallbackText.trim();
		if (!text) return 'WEBVTT\n';
		cues.push(`00:00:00.000 --> 00:00:01.000\n${escapeCue(text)}`);
	}
	return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function baseUrl(getEnv: (name: string) => string | undefined): string {
	const configured = getEnv('WHISPER_URL')?.trim() || DEFAULT_URL;
	let parsed: URL;
	try {
		parsed = new URL(configured);
	} catch {
		throw new AiError('unsupported', 'WHISPER_URL is not a valid URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new AiError('unsupported', 'WHISPER_URL must be http(s)');
	}
	return configured.replace(/\/+$/, '');
}

export async function transcribeAudio(input: {
	file: File;
	language: string;
	getEnv: (name: string) => string | undefined;
}): Promise<TranscriptionResult> {
	const rejected = rejectedUpload(input.file);
	if (rejected) throw new AiError('bad_request', rejected);

	const url = new URL(`${baseUrl(input.getEnv)}/asr`);
	url.searchParams.set('output', 'json');
	url.searchParams.set('task', 'transcribe');
	url.searchParams.set('vad_filter', 'true');
	if (input.language && input.language !== 'auto') {
		url.searchParams.set('language', input.language);
	}

	const form = new FormData();
	form.append('audio_file', input.file, input.file.name);

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			body: form,
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (caught) {
		if (caught instanceof Error && caught.name === 'TimeoutError') {
			throw new AiError('timeout', 'Whisper transcription timed out', { retryable: true });
		}
		throw new AiError('network', 'Whisper service is not reachable', { retryable: true });
	}

	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 500);
		throw new AiError('bad_response', `Whisper HTTP ${response.status} ${detail}`.trim(), {
			status: response.status,
			provider: 'whisper'
		});
	}

	let payload: WhisperResponse;
	try {
		payload = (await response.json()) as WhisperResponse;
	} catch {
		throw new AiError('invalid_output', 'Whisper returned invalid JSON', { provider: 'whisper' });
	}

	const segments = Array.isArray(payload.segments) ? payload.segments : [];
	const text =
		(typeof payload.text === 'string' && payload.text.trim()) ||
		segments
			.map((segment) => (typeof segment.text === 'string' ? segment.text.trim() : ''))
			.filter(Boolean)
			.join(' ');
	if (!text.trim()) {
		throw new AiError('invalid_output', 'Whisper returned an empty transcript', {
			provider: 'whisper'
		});
	}

	const last = segments.reduce((max, segment) => {
		const end = typeof segment.end === 'number' ? segment.end : 0;
		return end > max ? end : max;
	}, 0);

	return {
		text: text.trim(),
		vtt: buildVtt(segments, text),
		language:
			(typeof payload.language === 'string' && payload.language) ||
			(input.language === 'auto' ? 'auto' : input.language),
		durationSeconds: last > 0 ? Math.ceil(last) : null,
		provider: 'whisper',
		model: input.getEnv('WHISPER_MODEL')?.trim() || 'base'
	};
}

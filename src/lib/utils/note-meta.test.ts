import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { locales } from '$lib/paraglide/runtime';
import { NOTE_MOODS as SCHEMA_MOODS, NOTES_STATUSES } from '$lib/server/db/content/note.schema';
import {
	isReservedNoteSlug,
	NOTE_EMOTION_LABELS,
	NOTE_EMOTIONS,
	NOTE_LANGS,
	NOTE_MOOD_ICONS,
	NOTE_MOOD_LABELS,
	NOTE_MOODS,
	NOTE_STATUS_LABELS,
	NOTE_STATUSES,
	NOTE_WEATHER,
	noteEmotionLabel,
	noteMoodLabel,
	noteWeatherIconName,
	noteWeatherLabel
} from './note-meta';

/** The reviewed canonical vocabulary (Apple HKStateOfMind.Label, 38 cases). */
const CANONICAL_EMOTIONS = [
	'amazed',
	'amused',
	'angry',
	'annoyed',
	'anxious',
	'ashamed',
	'brave',
	'calm',
	'confident',
	'content',
	'disappointed',
	'discouraged',
	'disgusted',
	'drained',
	'embarrassed',
	'excited',
	'frustrated',
	'grateful',
	'guilty',
	'happy',
	'hopeful',
	'hopeless',
	'indifferent',
	'irritated',
	'jealous',
	'joyful',
	'lonely',
	'overwhelmed',
	'passionate',
	'peaceful',
	'proud',
	'relieved',
	'sad',
	'satisfied',
	'scared',
	'stressed',
	'surprised',
	'worried'
];

const ICON_DIR = 'node_modules/@tabler/icons-svelte-runes/dist/icons';
function iconExists(name: string): boolean {
	return existsSync(`${ICON_DIR}/${name}.svelte`);
}

describe('note-meta registries', () => {
	it('pins the locale set to the paraglide runtime', () => {
		expect([...NOTE_LANGS]).toEqual([...locales]);
	});

	it('keeps the status vocabulary in sync with the schema export', () => {
		expect(new Set(NOTE_STATUSES)).toEqual(new Set(NOTES_STATUSES));
	});

	it('keeps the mood vocabulary in sync with the schema export', () => {
		expect(new Set(NOTE_MOODS)).toEqual(new Set(SCHEMA_MOODS));
	});

	it('ships exactly the reviewed 38 emotions, each with three-locale labels', () => {
		expect([...NOTE_EMOTIONS].sort()).toEqual([...CANONICAL_EMOTIONS].sort());
		expect(new Set(NOTE_EMOTIONS).size).toBe(NOTE_EMOTIONS.length);
		for (const token of NOTE_EMOTIONS) {
			for (const lang of NOTE_LANGS) {
				expect(NOTE_EMOTION_LABELS[token][lang].trim().length).toBeGreaterThan(0);
			}
		}
	});

	it('labels every mood and status in every locale', () => {
		for (const mood of NOTE_MOODS) {
			for (const lang of NOTE_LANGS) {
				expect(NOTE_MOOD_LABELS[mood][lang].trim().length).toBeGreaterThan(0);
			}
		}
		for (const status of NOTE_STATUSES) {
			for (const lang of NOTE_LANGS) {
				expect(NOTE_STATUS_LABELS[status][lang].trim().length).toBeGreaterThan(0);
			}
		}
	});

	it('maps every mood to an icon that exists in the installed icon set', () => {
		for (const mood of NOTE_MOODS) expect(iconExists(NOTE_MOOD_ICONS[mood])).toBe(true);
	});

	it('ships the curated WMO subset with labels and real icons', () => {
		const codes = Object.keys(NOTE_WEATHER).map(Number);
		expect(codes.length).toBe(28);
		for (const code of codes) {
			expect(code).toBeGreaterThanOrEqual(0);
			expect(code).toBeLessThanOrEqual(99);
			for (const lang of NOTE_LANGS) {
				expect(NOTE_WEATHER[code].labels[lang].trim().length).toBeGreaterThan(0);
			}
			expect(iconExists(NOTE_WEATHER[code].icon)).toBe(true);
		}
	});

	it('renders unknown emotion tokens raw and localises known ones', () => {
		expect(noteEmotionLabel('happy', 'zh-cn')).toBe('开心');
		expect(noteEmotionLabel('happy', 'ja')).toBe('うれしい');
		expect(noteEmotionLabel('starstruck', 'en')).toBe('starstruck');
	});

	it('renders weather labels, raw unknown codes and null for absence', () => {
		expect(noteWeatherLabel(0, 'zh-cn')).toBe('晴朗');
		expect(noteWeatherLabel(95, 'ja')).toBe('雷雨');
		expect(noteWeatherLabel(42, 'en')).toBe('42');
		expect(noteWeatherLabel(null, 'en')).toBeNull();
		expect(noteWeatherIconName(0)).toBe('sun');
		expect(noteWeatherIconName(42)).toBeNull();
	});

	it('anchors reviewed translations (registry copy-paste guard)', () => {
		expect(NOTE_EMOTION_LABELS.sad['zh-cn']).toBe('难过');
		expect(NOTE_EMOTION_LABELS.happy.ja).toBe('うれしい');
		expect(NOTE_MOOD_LABELS.very_good.en).toBe('Very good');
		expect(noteMoodLabel('bad', 'zh-cn')).toBe('较差');
	});

	it('reserves the topics slug for the URL subtree', () => {
		expect(isReservedNoteSlug('topics')).toBe(true);
		expect(isReservedNoteSlug('travel')).toBe(false);
	});
});

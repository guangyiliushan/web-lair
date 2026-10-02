/**
 * Note-domain metadata, UI-safe (single source for server and client, in the
 * spirit of `ai-meta.ts`): statuses, the five-level mood, the closed Apple
 * emotion vocabulary and the WMO weather-code subset, each with three-locale
 * labels. The DB side (CHECK literals) is pinned separately by
 * `note.schema.ts` + `enum-drift.test.ts`; this module is the rendering and
 * editor side, and `note-meta.test.ts` keeps the two in sync. Decisions:
 * notes plan v0.4 §8 / ledger §13.9.
 */

/**
 * Locale tags shared with the paraglide runtime. Kept dependency-free so
 * plain tsx scripts can import this module; the test pins it to `locales`.
 */
export const NOTE_LANGS = ['en', 'zh-cn', 'ja'] as const;
export type NoteLang = (typeof NOTE_LANGS)[number];

/** Public notes list page size (client and server share it through this UI-safe module). */
export const NOTE_PAGE_SIZE = 12;

/* ── Statuses (mirror of `NOTES_STATUSES`, drift-guarded by test) ──────── */

export const NOTE_STATUSES = ['draft', 'private', 'scheduled', 'published', 'trash'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const NOTE_STATUS_LABELS: Record<NoteStatus, Record<NoteLang, string>> = {
	draft: { en: 'Draft', 'zh-cn': '草稿', ja: '下書き' },
	private: { en: 'Private', 'zh-cn': '私密', ja: '非公開' },
	scheduled: { en: 'Scheduled', 'zh-cn': '定时发布', ja: '予約公開' },
	published: { en: 'Published', 'zh-cn': '已发布', ja: '公開済み' },
	trash: { en: 'Trash', 'zh-cn': '回收站', ja: 'ゴミ箱' }
};

/* ── Mood: five coarse levels (DB CHECK `notes_mood_check`) ────────────── */

export const NOTE_MOODS = ['very_bad', 'bad', 'neutral', 'good', 'very_good'] as const;
export type NoteMood = (typeof NOTE_MOODS)[number];

export const NOTE_MOOD_LABELS: Record<NoteMood, Record<NoteLang, string>> = {
	very_bad: { en: 'Very bad', 'zh-cn': '很差', ja: 'とても悪い' },
	bad: { en: 'Bad', 'zh-cn': '较差', ja: '悪い' },
	neutral: { en: 'Neutral', 'zh-cn': '一般', ja: 'ふつう' },
	good: { en: 'Good', 'zh-cn': '较好', ja: '良い' },
	very_good: { en: 'Very good', 'zh-cn': '很好', ja: 'とても良い' }
};

/**
 * Tabler icon names (kebab) reserved for the mood UI; the icon-whitelist
 * entries land with that UI (nav-icons.ts ships curated names only).
 */
export const NOTE_MOOD_ICONS: Record<NoteMood, string> = {
	very_bad: 'mood-cry',
	bad: 'mood-sad',
	neutral: 'mood-neutral',
	good: 'mood-smile',
	very_good: 'mood-happy'
};

/* ── Emotions: the closed Apple vocabulary (HKStateOfMind.Label, 38) ───── */

export const NOTE_EMOTIONS = [
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
] as const;
export type NoteEmotion = (typeof NOTE_EMOTIONS)[number];

export const NOTE_EMOTION_LABELS: Record<NoteEmotion, Record<NoteLang, string>> = {
	amazed: { en: 'Amazed', 'zh-cn': '惊奇', ja: '驚嘆' },
	amused: { en: 'Amused', 'zh-cn': '被逗乐', ja: '面白い' },
	angry: { en: 'Angry', 'zh-cn': '生气', ja: '怒り' },
	annoyed: { en: 'Annoyed', 'zh-cn': '烦躁', ja: 'イライラ' },
	anxious: { en: 'Anxious', 'zh-cn': '焦虑', ja: '不安' },
	ashamed: { en: 'Ashamed', 'zh-cn': '羞愧', ja: '恥ずかしさ' },
	brave: { en: 'Brave', 'zh-cn': '勇敢', ja: '勇敢' },
	calm: { en: 'Calm', 'zh-cn': '平静', ja: '穏やか' },
	confident: { en: 'Confident', 'zh-cn': '自信', ja: '自信' },
	content: { en: 'Content', 'zh-cn': '满足', ja: '満足' },
	disappointed: { en: 'Disappointed', 'zh-cn': '失望', ja: '失望' },
	discouraged: { en: 'Discouraged', 'zh-cn': '气馁', ja: '落ち込み' },
	disgusted: { en: 'Disgusted', 'zh-cn': '厌恶', ja: '嫌悪' },
	drained: { en: 'Drained', 'zh-cn': '疲惫', ja: '疲労' },
	embarrassed: { en: 'Embarrassed', 'zh-cn': '难为情', ja: '照れくさい' },
	excited: { en: 'Excited', 'zh-cn': '兴奋', ja: 'わくわく' },
	frustrated: { en: 'Frustrated', 'zh-cn': '挫败', ja: 'もどかしい' },
	grateful: { en: 'Grateful', 'zh-cn': '感激', ja: '感謝' },
	guilty: { en: 'Guilty', 'zh-cn': '内疚', ja: '罪悪感' },
	happy: { en: 'Happy', 'zh-cn': '开心', ja: 'うれしい' },
	hopeful: { en: 'Hopeful', 'zh-cn': '充满希望', ja: '希望' },
	hopeless: { en: 'Hopeless', 'zh-cn': '绝望', ja: '絶望' },
	indifferent: { en: 'Indifferent', 'zh-cn': '无感', ja: '無関心' },
	irritated: { en: 'Irritated', 'zh-cn': '恼火', ja: 'いらだたしい' },
	jealous: { en: 'Jealous', 'zh-cn': '嫉妒', ja: '嫉妬' },
	joyful: { en: 'Joyful', 'zh-cn': '喜悦', ja: '喜び' },
	lonely: { en: 'Lonely', 'zh-cn': '孤独', ja: '孤独' },
	overwhelmed: { en: 'Overwhelmed', 'zh-cn': '不堪重负', ja: '圧倒される' },
	passionate: { en: 'Passionate', 'zh-cn': '热情', ja: '情熱' },
	peaceful: { en: 'Peaceful', 'zh-cn': '安宁', ja: '安らぎ' },
	proud: { en: 'Proud', 'zh-cn': '自豪', ja: '誇り' },
	relieved: { en: 'Relieved', 'zh-cn': '释然', ja: 'ほっとした' },
	sad: { en: 'Sad', 'zh-cn': '难过', ja: '悲しい' },
	satisfied: { en: 'Satisfied', 'zh-cn': '满意', ja: '納得' },
	scared: { en: 'Scared', 'zh-cn': '害怕', ja: '怖い' },
	stressed: { en: 'Stressed', 'zh-cn': '压力大', ja: 'ストレス' },
	surprised: { en: 'Surprised', 'zh-cn': '惊讶', ja: 'びっくり' },
	worried: { en: 'Worried', 'zh-cn': '担忧', ja: '心配' }
};

/**
 * Display label for one emotion token. Unknown tokens render raw (import
 * robustness: future/Apple-only words must not disappear from the page).
 */
export function noteEmotionLabel(token: string, lang: NoteLang): string {
	const labels = (NOTE_EMOTION_LABELS as Record<string, Record<NoteLang, string> | undefined>)[
		token
	];
	if (!labels) return token;
	return labels[lang] ?? labels.en;
}

/** Display label for one mood level. */
export function noteMoodLabel(mood: NoteMood, lang: NoteLang): string {
	return NOTE_MOOD_LABELS[mood][lang] ?? NOTE_MOOD_LABELS[mood].en;
}

/* ── Weather: WMO 4677 / Open-Meteo code subset (0-99 CHECK in DB) ─────── */

export interface NoteWeatherEntry {
	/**
	 * Tabler icon name (kebab) reserved for the weather UI; the icon-whitelist
	 * entries land with that UI (nav-icons.ts ships curated names only).
	 */
	icon: string;
	labels: Record<NoteLang, string>;
}

export const NOTE_WEATHER: Record<number, NoteWeatherEntry> = {
	0: { icon: 'sun', labels: { en: 'Clear sky', 'zh-cn': '晴朗', ja: '快晴' } },
	1: { icon: 'sun-high', labels: { en: 'Mainly clear', 'zh-cn': '大部晴朗', ja: 'おおむね晴れ' } },
	2: { icon: 'cloud', labels: { en: 'Partly cloudy', 'zh-cn': '局部多云', ja: '一部曇り' } },
	3: { icon: 'cloud-filled', labels: { en: 'Overcast', 'zh-cn': '阴天', ja: '曇り' } },
	45: { icon: 'cloud-fog', labels: { en: 'Fog', 'zh-cn': '雾', ja: '霧' } },
	48: { icon: 'cloud-fog', labels: { en: 'Rime fog', 'zh-cn': '霜雾', ja: '着氷性の霧' } },
	51: {
		icon: 'cloud-rain',
		labels: { en: 'Light drizzle', 'zh-cn': '毛毛雨（轻）', ja: '弱い霧雨' }
	},
	53: { icon: 'cloud-rain', labels: { en: 'Drizzle', 'zh-cn': '毛毛雨', ja: '霧雨' } },
	55: {
		icon: 'cloud-rain',
		labels: { en: 'Dense drizzle', 'zh-cn': '毛毛雨（浓）', ja: '濃い霧雨' }
	},
	56: {
		icon: 'cloud-snow',
		labels: { en: 'Light freezing drizzle', 'zh-cn': '冻毛毛雨（轻）', ja: '弱い着氷性霧雨' }
	},
	57: {
		icon: 'cloud-snow',
		labels: { en: 'Dense freezing drizzle', 'zh-cn': '冻毛毛雨（浓）', ja: '濃い着氷性霧雨' }
	},
	61: { icon: 'cloud-rain', labels: { en: 'Slight rain', 'zh-cn': '小雨', ja: '弱い雨' } },
	63: { icon: 'cloud-rain', labels: { en: 'Moderate rain', 'zh-cn': '中雨', ja: '雨' } },
	65: { icon: 'cloud-rain', labels: { en: 'Heavy rain', 'zh-cn': '大雨', ja: '強い雨' } },
	66: {
		icon: 'cloud-snow',
		labels: { en: 'Light freezing rain', 'zh-cn': '冻雨（轻）', ja: '弱い着氷性の雨' }
	},
	67: { icon: 'cloud-snow', labels: { en: 'Freezing rain', 'zh-cn': '冻雨', ja: '着氷性の雨' } },
	71: { icon: 'cloud-snow', labels: { en: 'Slight snow', 'zh-cn': '小雪', ja: '弱い雪' } },
	73: { icon: 'cloud-snow', labels: { en: 'Moderate snow', 'zh-cn': '中雪', ja: '雪' } },
	75: { icon: 'cloud-snow', labels: { en: 'Heavy snow', 'zh-cn': '大雪', ja: '強い雪' } },
	77: { icon: 'snowflake', labels: { en: 'Snow grains', 'zh-cn': '米雪', ja: '霧雪' } },
	80: {
		icon: 'cloud-rain',
		labels: { en: 'Slight showers', 'zh-cn': '阵雨（轻）', ja: '弱いにわか雨' }
	},
	81: { icon: 'cloud-rain', labels: { en: 'Moderate showers', 'zh-cn': '阵雨', ja: 'にわか雨' } },
	82: {
		icon: 'cloud-rain',
		labels: { en: 'Violent showers', 'zh-cn': '强阵雨', ja: '激しいにわか雨' }
	},
	85: {
		icon: 'cloud-snow',
		labels: { en: 'Light snow showers', 'zh-cn': '阵雪（轻）', ja: '弱いにわか雪' }
	},
	86: {
		icon: 'cloud-snow',
		labels: { en: 'Heavy snow showers', 'zh-cn': '阵雪（强）', ja: '強いにわか雪' }
	},
	95: { icon: 'cloud-storm', labels: { en: 'Thunderstorm', 'zh-cn': '雷暴', ja: '雷雨' } },
	96: {
		icon: 'cloud-storm',
		labels: { en: 'Thunderstorm with slight hail', 'zh-cn': '雷暴伴小冰雹', ja: '雷雨（ひょう）' }
	},
	99: {
		icon: 'cloud-storm',
		labels: { en: 'Thunderstorm with heavy hail', 'zh-cn': '雷暴伴大冰雹', ja: '雷雨（大ひょう）' }
	}
};

/** Label for a weather code; unknown codes render the raw number (grill default). */
export function noteWeatherLabel(code: number | null | undefined, lang: NoteLang): string | null {
	if (code === null || code === undefined) return null;
	const entry = NOTE_WEATHER[code];
	if (!entry) return String(code);
	return entry.labels[lang] ?? entry.labels.en;
}

/** Tabler icon name for a weather code, or null when unknown/absent. */
export function noteWeatherIconName(code: number | null | undefined): string | null {
	if (code === null || code === undefined) return null;
	return NOTE_WEATHER[code]?.icon ?? null;
}

/* ── URL space: reserved slugs (notes subtree) ─────────────────────────── */

/**
 * Words a note slug must not claim: `/notes/<slug>` sits next to the
 * `/notes/topics/**` subtree, and a note named `topics` would own the bare
 * `/notes/topics` URL (kit falls back to `[slug]` there). Mirrors the pages
 * reserved-word guard; extend when notes gain new sub-routes.
 */
export const NOTE_RESERVED_SLUGS: ReadonlySet<string> = new Set(['topics']);

export function isReservedNoteSlug(slug: string): boolean {
	return NOTE_RESERVED_SLUGS.has(slug);
}

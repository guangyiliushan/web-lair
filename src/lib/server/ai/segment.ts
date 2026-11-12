/**
 * Source segmentation for long translations (Task C1).
 *
 * The chunker runs on **protected** markdown (`protectMarkdown` output), so
 * fences, inline code, URLs and mentions are already `[[WL…]]` tokens: those
 * atoms must never be cut. It splits on structure, never on a byte budget
 * alone:
 *
 *   - blank lines separate blocks (paragraphs, headings, lists, tables);
 *   - a block that fits is packed with its neighbours;
 *   - an oversized block splits on line boundaries, then sentence ends, and
 *     only then at a hard character cut;
 *   - a table repeats its header on every part (it cannot be rejoined
 *     byte-for-byte, but it stays valid markdown);
 *   - nothing inside a `[[WL…]]` placeholder is ever split.
 *
 * Each chunk carries the separator that precedes it, so the caller can
 * reassemble the source exactly (tables excepted) and, more importantly, can
 * translate chunk-by-chunk without losing the original whitespace.
 */

export interface TranslationChunk {
	text: string;
	/** Joins this chunk to the previous one: blank line, newline, or none. */
	separator: '\n\n' | '\n' | '';
	/** Nearest heading above the chunk, for continuity context. */
	heading: string | null;
}

export interface SegmentOptions {
	/**
	 * Source characters per chunk (code points). Size this from the target
	 * model's output speed, not its `max_tokens`: 3-4k output tokens is about
	 * 60-90 seconds, which is the progress granularity the drawer promises.
	 */
	maxChars: number;
}

/** A starting point for a first run; calibrate against `ai_usage.output_tokens`. */
export const DEFAULT_CHUNK_CHARS = 4000;

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]+\|?\s*$/;

function lengthOf(text: string): number {
	return [...text].length;
}

function isHeading(line: string): string | null {
	const match = HEADING_RE.exec(line);
	return match ? match[2].trim() : null;
}

function isTable(lines: readonly string[]): boolean {
	return lines.length >= 2 && lines[0].trim().startsWith('|') && TABLE_SEPARATOR_RE.test(lines[1]);
}

/**
 * Split one line into pieces that end after a sentence mark (or the end of
 * the line). Trailing whitespace stays inside the piece, so concatenating the
 * pieces reproduces the line exactly.
 */
function sentencePieces(line: string): string[] {
	const pieces: string[] = [];
	const re = /[^。！？!?]*[。！？!?]+[\s]*|[^。！？!?]+$/gu;
	for (const match of line.matchAll(re)) {
		if (match[0]) pieces.push(match[0]);
	}
	return pieces.length > 0 ? pieces : [line];
}

/**
 * Cut at code-point `maxChars`, backing off when the cut would land inside a
 * `[[WL…]]` placeholder. Returns the head and the rest.
 */
function safeCut(text: string, maxChars: number): [string, string] {
	const chars = [...text];
	let cut = Math.min(Math.max(1, maxChars), chars.length);
	const head = chars.slice(0, cut).join('');
	const open = head.lastIndexOf('[[');
	const close = head.lastIndexOf(']]');
	if (open > close) {
		const before = lengthOf(head.slice(0, open));
		// A placeholder longer than the whole budget is pathological; keeping
		// it whole is more important than honouring the budget.
		if (before > 0) cut = before;
	}
	return [chars.slice(0, cut).join(''), chars.slice(cut).join('')];
}

/** Split one oversized line into pieces no longer than `maxChars`. */
function splitLine(line: string, maxChars: number): string[] {
	if (lengthOf(line) <= maxChars) return [line];
	const parts: string[] = [];
	let current = '';
	for (const piece of sentencePieces(line)) {
		if (lengthOf(current) + lengthOf(piece) <= maxChars) {
			current += piece;
			continue;
		}
		if (current) {
			parts.push(current);
		}
		let rest = piece;
		while (lengthOf(rest) > maxChars) {
			const [head, tail] = safeCut(rest, maxChars);
			parts.push(head);
			rest = tail;
		}
		current = rest;
	}
	if (current) parts.push(current);
	return parts;
}

interface Part {
	text: string;
	/** Separator before this part *within* its block. */
	separator: '\n' | '';
}

/** Split a table by rows, repeating header + separator on every part. */
function splitTable(lines: readonly string[], maxChars: number): Part[] {
	const [header, separator, ...rows] = lines;
	const prefix = `${header}\n${separator}\n`;
	const parts: Part[] = [];
	let current: string[] = [];
	let currentChars = lengthOf(prefix);
	const flush = (): void => {
		if (current.length === 0) return;
		parts.push({
			text: prefix + current.join('\n'),
			separator: parts.length === 0 ? '' : '\n'
		});
		current = [];
		currentChars = lengthOf(prefix);
	};
	for (const row of rows) {
		const rowChars = lengthOf(row) + 1;
		if (current.length > 0 && currentChars + rowChars > maxChars) flush();
		current.push(row);
		currentChars += rowChars;
	}
	flush();
	return parts.length > 0 ? parts : [{ text: prefix.trimEnd(), separator: '' }];
}

/** Split a multi-line block on line boundaries, then split lines that are still too long. */
function splitBlock(block: string, maxChars: number): Part[] {
	const lines = block.split('\n');
	if (isTable(lines)) return splitTable(lines, maxChars);
	const parts: Part[] = [];
	let group: string[] = [];
	let groupChars = 0;
	const flushGroup = (): void => {
		if (group.length === 0) return;
		parts.push({ text: group.join('\n'), separator: parts.length === 0 ? '' : '\n' });
		group = [];
		groupChars = 0;
	};
	for (const line of lines) {
		const lineChars = lengthOf(line);
		if (lineChars > maxChars) {
			flushGroup();
			splitLine(line, maxChars).forEach((piece, index) => {
				parts.push({
					text: piece,
					// Sentences of one line rejoin with no separator; the first
					// piece still starts on a new line after the previous group.
					separator: parts.length === 0 ? '' : index === 0 ? '\n' : ''
				});
			});
			continue;
		}
		if (group.length > 0 && groupChars + 1 + lineChars > maxChars) flushGroup();
		group.push(line);
		groupChars += (group.length > 1 ? 1 : 0) + lineChars;
	}
	flushGroup();
	return parts.length > 0 ? parts : [{ text: block, separator: '' }];
}

/**
 * Cut a protected markdown document into translation chunks. The returned
 * chunks are in source order; `joinChunks` reassembles the normalised source
 * (single blank lines, tables excepted).
 */
export function segmentMarkdown(
	text: string,
	options: SegmentOptions = { maxChars: DEFAULT_CHUNK_CHARS }
): TranslationChunk[] {
	const maxChars = Math.floor(options.maxChars);
	if (!Number.isFinite(maxChars) || maxChars < 1) {
		throw new RangeError(`segmentMarkdown needs maxChars >= 1 (got ${options.maxChars})`);
	}
	const blocks = text
		.split(/\n[ \t]*\n/)
		.map((block) => block.replace(/[ \t]+$/gm, '').trimEnd())
		.filter((block) => block.trim().length > 0);
	if (blocks.length === 0) return [];

	const chunks: TranslationChunk[] = [];
	/** Latest heading seen, and the heading that labels the chunk being built. */
	let latestHeading: string | null = null;
	let currentHeading: string | null = null;
	let current: string | null = null;
	let currentChars = 0;

	const flush = (): void => {
		if (current !== null) {
			chunks.push({
				text: current,
				separator: chunks.length === 0 ? '' : '\n\n',
				heading: currentHeading
			});
			current = null;
			currentChars = 0;
		}
	};

	for (const block of blocks) {
		const blockHeading = isHeading(block.split('\n')[0] ?? '');
		if (blockHeading !== null) latestHeading = blockHeading;
		const blockChars = lengthOf(block);
		if (current !== null && currentChars + 2 + blockChars > maxChars) flush();
		// A chunk is labelled by the heading it starts under; a heading packed
		// into an existing chunk only changes the label of the next one, so a
		// short document stays one chunk instead of one chunk per section.
		if (current === null) currentHeading = latestHeading;
		if (blockChars <= maxChars) {
			current = current === null ? block : `${current}\n\n${block}`;
			currentChars += (currentChars === 0 ? 0 : 2) + blockChars;
			continue;
		}
		// The block alone exceeds the budget: emit it piece by piece.
		flush();
		const parts = splitBlock(block, maxChars);
		parts.forEach((part, index) => {
			chunks.push({
				text: part.text,
				separator: chunks.length === 0 ? '' : index === 0 ? '\n\n' : part.separator,
				heading: currentHeading
			});
		});
	}
	flush();
	return chunks;
}

/** Reassemble the (normalised) source from chunks; used by tests and callers. */
export function joinChunks(chunks: readonly TranslationChunk[]): string {
	return chunks
		.map((chunk, index) => (index === 0 ? chunk.text : chunk.separator + chunk.text))
		.join('');
}

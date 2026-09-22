/**
 * Shared implementation of the inline two-character delimiter extensions --
 * spoiler (`||`) and mark (`==`).
 *
 * The micromark attention pattern is a port of
 * micromark-extension-gfm-strikethrough; three differences from upstream /
 * plain CommonMark are worth recording:
 * - Delimiter runs are fixed at length 2 (spec 2 #5/#6): single or >=3
 *   delimiters never parse.
 * - The delimiter character is parameterized -- one implementation derives
 *   both spoiler (`||`) and mark (`==`). Flanking (4.3) is equivalent to
 *   upstream combination-wise; `a == b == c` does not pair.
 * - Delimiters register in `attentionMarkers` (as upstream does), which
 *   participates in adjacent-emphasis flanking: `a*==b==*` pairs into
 *   `<em>` (same as gfm-strikethrough's `a*~~b~~*`). That is the only extra
 *   observable effect versus a pipeline without this extension registered.
 *
 * Escaping (4.4) and "disabled inside inline code / math" (4.2) hold by
 * construction: delimiters consumed by characterEscape never reach this
 * tokenizer, and code/math consume their content without triggering inline
 * text extensions.
 */
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { resolveAll } from 'micromark-util-resolve-all';
import type {
	Code,
	Effects,
	Event,
	Extension,
	State,
	Token,
	TokenType,
	TokenizeContext
} from 'micromark-util-types';
import type { Plugin } from 'unified';
import type { Parents, PhrasingContent, Root } from 'mdast';
import type { ElementContent, Element } from 'hast';

/**
 * Custom mdast node types.
 * Defined structurally (no `extends` on mdast's Parent): they are shape
 * contracts only -- unist visit and mdast-util-to-hast consume them by
 * structure.
 */
export interface AttentionNode {
	children: PhrasingContent[];
}

export interface SpoilerNode extends AttentionNode {
	type: 'spoiler';
}

export interface MarkNode extends AttentionNode {
	type: 'mark';
}

declare module 'mdast' {
	interface PhrasingContentMap {
		spoiler: SpoilerNode;
		mark: MarkNode;
	}
}

declare module 'micromark-util-types' {
	interface TokenTypeMap {
		spoiler: Token;
		spoilerSequence: Token;
		spoilerSequenceTemporary: Token;
		spoilerText: Token;
		mark: Token;
		markSequence: Token;
		markSequenceTemporary: Token;
		markText: Token;
	}
}

export interface AttentionMarkerSpec {
	/** token / mdast node name, e.g. 'spoiler' */
	name: string;
	/** delimiter character code (ASCII) */
	markerCode: number;
}

/** classifyCharacter's whitespace group value (micromark-util-symbol constants.characterGroupWhitespace) */
const WHITESPACE = 1;

/** micromark syntax extension factory */
export function createAttentionSyntax(spec: AttentionMarkerSpec): Extension {
	const { name, markerCode } = spec;
	const sequenceType = `${name}SequenceTemporary`;

	const tokenizer = {
		name,
		tokenize: tokenizeAttention,
		resolveAll: resolveAllAttention
	};

	// Internal state functions use a loose return type (State | void) while
	// micromark's Tokenizer contract narrows to State -- closed with one assert
	return {
		text: { [`${markerCode}`]: tokenizer },
		insideSpan: { null: [tokenizer] },
		attentionMarkers: { null: [markerCode] }
	} as unknown as Extension;

	function resolveAllAttention(
		this: TokenizeContext,
		events: Array<Event>,
		context: TokenizeContext
	): Array<Event> {
		let index = -1;

		while (++index < events.length) {
			if (
				events[index][0] === 'enter' &&
				events[index][1].type === sequenceType &&
				events[index][1]._close
			) {
				let open = index;

				while (open--) {
					if (
						events[open][0] === 'exit' &&
						events[open][1].type === sequenceType &&
						events[open][1]._open &&
						// delimiter runs must match in length (fixed at 2 here; kept for upstream parity)
						events[index][1].end.offset - events[index][1].start.offset ===
							events[open][1].end.offset - events[open][1].start.offset
					) {
						// dynamic token type (template literal) cannot be statically proven to be in TokenTypeMap
						events[index][1].type = `${name}Sequence` as Token['type'];
						events[open][1].type = `${name}Sequence` as Token['type'];

						const attention = {
							type: name,
							start: { ...events[open][1].start },
							end: { ...events[index][1].end }
						} as unknown as Token;

						const text = {
							type: `${name}Text`,
							start: { ...events[open][1].end },
							end: { ...events[index][1].start }
						} as unknown as Token;

						const nextEvents: Array<Event> = [
							['enter', attention, context],
							['enter', events[open][1], context],
							['exit', events[open][1], context],
							['enter', text, context]
						];

						// the run may nest other inline extensions (e.g. emphasis); hand back to the parser
						const insideSpan = context.parser.constructs.insideSpan?.null;
						if (insideSpan) {
							splice(
								nextEvents,
								nextEvents.length,
								0,
								resolveAll(insideSpan, events.slice(open + 1, index), context)
							);
						}

						splice(nextEvents, nextEvents.length, 0, [
							['exit', text, context],
							['enter', events[index][1], context],
							['exit', events[index][1], context],
							['exit', attention, context]
						]);
						splice(events, open - 1, index - open + 3, nextEvents);
						index = open + nextEvents.length - 2;
						break;
					}
				}
			}
		}

		index = -1;
		while (++index < events.length) {
			if (events[index][1].type === sequenceType) {
				events[index][1].type = 'data';
			}
		}

		return events;
	}

	function tokenizeAttention(
		this: TokenizeContext,
		effects: Effects,
		ok: State,
		nok: State
	): State {
		const previous = this.previous;
		const events = this.events;
		let size = 0;
		// classification of the char before the run's first char: undefined = other, 1 = whitespace/boundary, 2 = Unicode punctuation
		let before: number | undefined;
		// self-referential type for the internal state functions (structural equivalent of micromark's State)
		type Step = (code: Code) => Step | undefined;

		return start;

		function start(code: Code): Step | undefined {
			// do not trigger right after the same delimiter (the previous one was
			// already resolved to data), except for a literal delimiter from an escape
			if (previous === markerCode && events[events.length - 1][1].type !== 'characterEscape') {
				return nok(code);
			}
			before = classifyCharacter(previous);
			effects.enter(sequenceType as TokenType);
			return more(code);
		}

		function more(code: Code): Step | undefined {
			if (code === markerCode) {
				// exactly 2 delimiters: a 3rd one fails immediately
				if (size > 1) return nok(code);
				effects.consume(code);
				size++;
				return more;
			}
			if (size !== 2) return nok(code);
			const token = effects.exit(sequenceType as TokenType);
			const after = classifyCharacter(code);
			// classifyCharacter returns: 1 = whitespace/boundary, 2 = Unicode punctuation,
			// undefined = other. CommonMark emphasis flanking (4.3):
			// left-flanking = next is not whitespace && (next is not punctuation || prev is whitespace/punctuation)
			token._open = after !== WHITESPACE && (after === undefined || before !== undefined);
			token._close = before !== WHITESPACE && (before === undefined || after !== undefined);
			return ok(code);
		}
	}
}

type FromMarkdownEnter = { enter(node: object, token: Token): void };
type FromMarkdownExit = { exit(token: Token): void };

/** mdast-util-from-markdown extension factory */
export function createAttentionFromMarkdown(name: string) {
	return {
		canContainEols: [name],
		enter: {
			[name](this: FromMarkdownEnter, token: Token) {
				this.enter({ type: name, children: [] }, token);
			}
		},
		exit: {
			[name](this: FromMarkdownExit, token: Token) {
				this.exit(token);
			}
		}
	};
}

/**
 * remark plugin factory: registers the attention extension for a given
 * delimiter with unified.
 *
 * unified's data(key, value) assigns, so it must be merged with existing
 * extensions manually -- otherwise it would clobber previously registered
 * syntax extensions such as remark-gfm / remark-directive.
 */
export function createAttentionPlugin(spec: AttentionMarkerSpec): Plugin<[], Root> {
	return function () {
		const data = this.data();
		data.micromarkExtensions = [...(data.micromarkExtensions ?? []), createAttentionSyntax(spec)];
		data.fromMarkdownExtensions = [
			...(data.fromMarkdownExtensions ?? []),
			createAttentionFromMarkdown(spec.name)
		];
	};
}

type ToHastState = {
	all(node: Parents): Array<ElementContent>;
};

function collectText(node: Parents): string {
	let out = '';
	for (const child of node.children) {
		if (child.type === 'text') out += child.value;
		else if ('children' in child) out += collectText(child as Parents);
	}
	return out;
}

/**
 * remark-rehype hast handler factory: spoiler -> span.spoiler, mark -> mark.
 * `titleFromText` puts the raw content into a `title` attribute so masked
 * spoilers reveal their text on hover before the style transition runs
 * (the mask carries the raw content as its title tooltip).
 */
export function createAttentionHandler(
	tagName: string,
	className?: string,
	options?: { titleFromText?: boolean }
) {
	return (_state: ToHastState, node: Parents): Element => {
		const properties: Element['properties'] = className ? { className: [className] } : {};
		if (options?.titleFromText) {
			const text = collectText(node).trim();
			if (text) properties.title = text;
			// keyboard reachability: :focus reveals the mask (spec 4.5 a11y intent)
			properties.tabIndex = 0;
		}
		return {
			type: 'element',
			tagName,
			properties,
			children: _state.all(node)
		};
	};
}

/** remark-rehype handlers shared by both pipelines */
export const attentionHandlers = {
	spoiler: createAttentionHandler('span', 'spoiler', { titleFromText: true }),
	mark: createAttentionHandler('mark')
};

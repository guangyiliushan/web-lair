import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import type {
	Code,
	Effects,
	Extension as MicromarkExtension,
	State,
	TokenizeContext,
	Token,
	Tokenizer
} from 'micromark-util-types';

declare module 'micromark-util-types' {
	interface TokenTypeMap {
		mathParenMarker: Token;
		mathParenText: Token;
		mathParenInline: Token;
		mathParenDisplay: Token;
	}
}

/** The mdast-util-from-markdown extension shape, kept structural (the package
 * is transitive and we only need the two handler maps). */
interface FromMarkdownHandlerContext {
	stack: unknown[];
	enter(node: unknown, token: unknown): void;
	exit(token: unknown): void;
	sliceSerialize(token: unknown): string;
}
interface FromMarkdownExtensionLike {
	enter: Record<string, (this: FromMarkdownHandlerContext, token: Token) => void>;
	exit: Record<string, (this: FromMarkdownHandlerContext, token: Token) => void>;
}
import { codes } from 'micromark-util-symbol';

/**
 * `\(…\)` inline math and `\[…\]` display math (spec 2 #2): the unambiguous
 * equivalents of `$…$`/`$$…$$`.
 *
 * The escapes are resolved while parsing — CommonMark's character escape
 * consumes `\(` before any post-parse plugin can see it — so this has to be a
 * micromark construct. It claims `\(`/`\[` only when the matching closer
 * exists on the same line; the whole scan runs inside a partial attempt, so a
 * miss rewinds every token and the core escape handles the backslash: the
 * author gets the literal parenthesis, which is the spec's promise. Escaping
 * (`\\(x\\)`) and code-span isolation fall out of the parsing architecture,
 * and inside `$…$` the dollar construct consumes the text first (spec 4.1
 * priority 2).
 *
 * The mdast nodes are built exactly like mdast-util-math's so rehype-katex
 * treats both spellings identically.
 */
const BACKSLASH = 92;
const LPAREN = 40;
const RPAREN = 41;
const LBRACKET = 91;
const RBRACKET = 93;

const INLINE_DATA = {
	hName: 'code',
	hProperties: { className: ['language-math', 'math-inline'] }
};
const DISPLAY_DATA = {
	hName: 'pre',
	hProperties: { className: ['language-math', 'math-display'] },
	hChildren: [
		{
			type: 'element',
			tagName: 'code',
			properties: { className: ['language-math', 'math-display'] },
			children: []
		}
	]
};

function tokenizeMathParen(this: TokenizeContext, effects: Effects, ok: State, nok: State) {
	const tokenizeWhole: Tokenizer = (effects2, ok2, nok2) => {
		let closer = 0;
		let display = false;

		return begin;

		function begin(code: Code) {
			if (code !== BACKSLASH) return nok2(code);
			effects2.enter('mathParenMarker');
			effects2.consume(code);
			return afterBackslash;
		}

		function afterBackslash(code: Code) {
			if (code === LPAREN) {
				closer = RPAREN;
				display = false;
			} else if (code === LBRACKET) {
				closer = RBRACKET;
				display = true;
			} else {
				return nok2(code);
			}
			effects2.consume(code);
			effects2.exit('mathParenMarker');
			effects2.enter(display ? 'mathParenDisplay' : 'mathParenInline');
			effects2.enter('mathParenText');
			return inside;
		}

		function inside(code: Code) {
			if (code === codes.eof || code === codes.carriageReturn || code === codes.lineFeed) {
				// end of line/content without a closer
				return nok2(code);
			}
			if (code === BACKSLASH) {
				return effects2.attempt(
					{ tokenize: tokenizeCloser as unknown as Tokenizer, partial: true },
					after,
					content
				)(code);
			}
			effects2.consume(code);
			return inside;
		}

		// a function declaration (hoisted) — a const here would sit after the
		// `return begin` above and never initialise
		function tokenizeCloser(effects3: Effects, ok3: State, nok3: State): State | void {
			return function closerStart(code: Code) {
				if (code !== BACKSLASH) return nok3(code);
				effects3.enter('mathParenMarker');
				effects3.consume(code);
				return closerAfterBackslash;
			};
			function closerAfterBackslash(code: Code) {
				if (code !== closer) return nok3(code);
				effects3.consume(code);
				effects3.exit('mathParenMarker');
				return ok3(code);
			}
		}

		// the closer: close the text first so the marker is not part of it
		function after(code: Code) {
			effects2.exit('mathParenText');
			effects2.exit(display ? 'mathParenDisplay' : 'mathParenInline');
			return ok2(code);
		}

		// not a closer: the backslash is content
		function content(code: Code) {
			effects2.consume(code);
			return inside;
		}
	};

	return function start(code: Code) {
		if (code !== BACKSLASH) return nok(code);
		// Everything (opening marker, content, closing marker) happens inside
		// this attempt: a failure anywhere rewinds the tokens, which a plain
		// post-effect nok could not do.
		return effects.attempt(
			{ tokenize: tokenizeWhole as unknown as Tokenizer, partial: true },
			ok,
			nok
		)(code);
	};
}

const micromarkMathParen: MicromarkExtension = {
	// the construct must be an object: micromark calls construct.tokenize
	text: { [BACKSLASH]: [{ tokenize: tokenizeMathParen }] }
};

const fromMarkdownMathParen: FromMarkdownExtensionLike = {
	enter: {
		mathParenInline(token) {
			this.enter({ type: 'inlineMath', value: '', data: INLINE_DATA } as never, token);
		},
		mathParenDisplay(token) {
			this.enter({ type: 'math', value: '', data: DISPLAY_DATA } as never, token);
		},
		mathParenText() {
			// content is collected on exit
		},
		mathParenMarker() {
			// markers carry no text
		}
	},
	exit: {
		mathParenText(token) {
			const node = this.stack[this.stack.length - 1] as { value?: string };
			node.value = (node.value ?? '') + this.sliceSerialize(token);
		},
		mathParenInline(token) {
			this.exit(token);
		},
		mathParenDisplay(token) {
			this.exit(token);
		},
		mathParenMarker() {
			// no text
		}
	}
};

export const remarkMathParen: Plugin<[], Root> = function () {
	const data = this.data();
	const micromarkExtensions = (data.micromarkExtensions ??= []);
	const fromMarkdownExtensions = (data.fromMarkdownExtensions ??= []);
	micromarkExtensions.push(micromarkMathParen);
	fromMarkdownExtensions.push(fromMarkdownMathParen as never);
};

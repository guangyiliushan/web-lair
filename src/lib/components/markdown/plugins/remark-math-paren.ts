import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import type {
	Code,
	Effects,
	Extension as MicromarkExtension,
	State,
	Token,
	TokenizeContext,
	Tokenizer
} from 'micromark-util-types';
import { codes } from 'micromark-util-symbol';

/**
 * `\(…\)` inline math (spec 2 #2): the unambiguous equivalent of `$…$`, the
 * escape hatch for the `$` ambiguity.
 *
 * The escapes are resolved while parsing — CommonMark's character escape
 * consumes `\(` before any post-parse plugin can see it — so this is a
 * micromark construct. It claims `\(` only when a matching `\)` exists on the
 * same line; a miss rewinds through the ordinary `nok` path (micromark stores
 * and restores the event stream itself) and the core escape handles the
 * backslash, so the author gets the literal parenthesis.
 *
 * It emits the SAME token names micromark-extension-math uses
 * (`mathText` / `mathTextSequence` / `mathTextData`), so remark-math's
 * already-registered from-markdown extension builds the mdast node: value,
 * `data.hChildren` (what rehype-katex reads) and a position covering the whole
 * `\(…\)`. Hand-rolling that node silently produced empty formulas before; the
 * lesson is that reusing the upstream token contract is the only way both
 * halves stay in sync.
 *
 * Performance: a failing `\(` must not rescan the rest of its line, or a line
 * full of `\(` goes quadratic (measured: 16 KB → ~49 s). The first failure on
 * a line proves there is no closer from its opening offset to that line's end,
 * which is a suffix of the line — so any later attempt inside it can fail in
 * O(1). That is a per-document memory (micromark gives tokenizers no way back
 * to the source text; a synthetic-token slice trips its buffer assertion).
 *
 * Not implemented: `\[…\]`. Spec 4.1 mentions it in passing, but a display
 * math node is block-level in mdast while the brackets sit inside a
 * paragraph, so the flow-token machinery would apply. Registered as a spec
 * question.
 */
declare module 'micromark-util-types' {
	interface TokenTypeMap {
		mathText: Token;
		mathTextData: Token;
		mathTextSequence: Token;
	}
}

interface NoCloserRegion {
	from: number;
	to: number;
}

function createMathParenSyntax(
	memoryFor: (context: TokenizeContext) => { region: NoCloserRegion | null }
): MicromarkExtension {
	const tokenizeMathParen = function (
		this: TokenizeContext,
		effects: Effects,
		ok: State,
		nok: State
	) {
		const nowOffset = () => this.now().offset;
		const memory = memoryFor(this);
		const startOffset = nowOffset();
		// A previous failing scan on this line already proved there is no closer
		// further along it: skip the rescan entirely.
		if (memory.region && startOffset >= memory.region.from && startOffset <= memory.region.to) {
			return nok;
		}

		// declared before the returned state: a declaration after `return` would
		// never initialise (TDZ)
		let dataOpen = false;
		function openData(): void {
			if (dataOpen) return;
			dataOpen = true;
			effects.enter('mathTextData');
		}

		return function start(code: Code): State | undefined {
			if (code !== codes.backslash) return nok(code);
			effects.enter('mathText');
			effects.enter('mathTextSequence');
			effects.consume(code);
			return afterBackslash;
		};

		function afterBackslash(code: Code): State | undefined {
			if (code !== codes.leftParenthesis) return nok(code);
			effects.consume(code);
			effects.exit('mathTextSequence');
			// mathTextData is entered lazily, on the first content character:
			// micromark asserts data tokens are non-empty, and a failed `\(`
			// must not leave an entered-but-empty one behind
			return inside;
		}

		function inside(code: Code): State | undefined {
			if (code === codes.eof || code === codes.carriageReturn || code === codes.lineFeed) {
				// no closer on this line: remember the region so the rest of the
				// line's candidates fail without scanning, then rewind
				memory.region = { from: startOffset, to: nowOffset() };
				return nok(code);
			}
			if (code === codes.backslash) {
				return effects.attempt(
					{ tokenize: tokenizeCloser as unknown as Tokenizer },
					afterCloser,
					contentBackslash
				)(code);
			}
			openData();
			effects.consume(code);
			return inside;
		}

		function tokenizeCloser(effects2: Effects, ok2: State, nok2: State): State | undefined {
			return function closerStart(code: Code): State | undefined {
				if (code !== codes.backslash) return nok2(code);
				// `\(\)` has no content: not math, fall back to literals
				if (!dataOpen) return nok2(code);
				// close the data token first: the closer sequence is a sibling in
				// the upstream token shape (mathText > sequence, data, sequence)
				effects2.exit('mathTextData');
				effects2.enter('mathTextSequence');
				effects2.consume(code);
				return closerAfterBackslash;
			};
			function closerAfterBackslash(code: Code): State | undefined {
				if (code !== codes.rightParenthesis) return nok2(code);
				effects2.consume(code);
				effects2.exit('mathTextSequence');
				return ok2(code);
			}
		}

		function afterCloser(code: Code): State | undefined {
			effects.exit('mathText');
			// the math was found in this region: forget the old proof
			memory.region = null;
			return ok(code);
		}

		function contentBackslash(code: Code): State | undefined {
			openData();
			effects.consume(code);
			return inside;
		}
	};

	return {
		// the construct must be an object: micromark calls construct.tokenize
		text: { [codes.backslash]: [{ tokenize: tokenizeMathParen as unknown as Tokenizer }] }
	};
}

export const remarkMathParen: Plugin<[], Root> = function () {
	const data = this.data();
	const micromarkExtensions = (data.micromarkExtensions ??= []);
	const memories = new WeakMap<object, { region: NoCloserRegion | null }>();
	micromarkExtensions.push(
		createMathParenSyntax((context) => {
			// the parser object lives per document, so the WeakMap is correct and
			// lifetime-safe
			const parser = context.parser as unknown as object;
			let memory = memories.get(parser);
			if (!memory) {
				memory = { region: null };
				memories.set(parser, memory);
			}
			return memory;
		})
	);
};

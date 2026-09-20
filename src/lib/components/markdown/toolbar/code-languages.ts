/**
 * Languages offered by the code-block dialog. Fence info strings are
 * free-form (spec 3.3 allows any identifier), so this list is a convenience
 * — the dialog also offers the typed query itself as a language.
 */
export const CODE_LANGUAGES: readonly string[] = [
	'ts',
	'tsx',
	'js',
	'jsx',
	'mjs',
	'svelte',
	'vue',
	'astro',
	'html',
	'css',
	'scss',
	'less',
	'json',
	'jsonc',
	'yaml',
	'toml',
	'ini',
	'md',
	'mdx',
	'bash',
	'shell',
	'zsh',
	'powershell',
	'sql',
	'graphql',
	'python',
	'ruby',
	'go',
	'rust',
	'java',
	'kotlin',
	'swift',
	'c',
	'cpp',
	'csharp',
	'php',
	'lua',
	'dart',
	'r',
	'diff',
	'http',
	'xml',
	'csv',
	'dockerfile',
	'nginx',
	'mermaid',
	'makefile',
	'tex'
];

/**
 * Fence info strings must survive as a single token. The allowed set matches
 * the editor's own code importer (`CODE_START_REGEX` accepts `[\w-]` around
 * the fence): allowing anything wider (e.g. `+`, `#`, `.` for C++/C#) would
 * round-trip badly — the export writes the language, the importer then keeps
 * only `[\w-]` and spills the rest into the code body.
 */
export function sanitizeLanguage(input: string): string {
	return input
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, '')
		.slice(0, 32);
}

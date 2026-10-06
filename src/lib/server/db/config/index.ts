// Explicit .ts specifier: this barrel stays resolvable under plain Node
// (reached from the jobs side via the Node-loadable options registry).
export * from './option.schema.ts';

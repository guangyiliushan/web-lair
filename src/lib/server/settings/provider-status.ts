// Provider status is a cross-page contract: test results and
// connection errors must never carry a token, an endpoint query string or a
// stack. The caller owns the test action; this helper only makes the message
// safe for the shared component.
export function sanitizeProviderError(error: unknown, maxLength = 200): string {
	let message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
	// Whole URLs first: a signed query string is the common leak.
	message = message.replace(/https?:\/\/\S+/gi, '[url]');
	message = message.replace(/\bauthorization\s*[:=]\s*.+$/gi, 'authorization=[redacted]');
	message = message.replace(
		/\b(key|token|secret|password|passphrase|credential)\b\s*[:=]\s*\S+/gi,
		'$1=[redacted]'
	);
	message = message.replace(/\s+/g, ' ').trim();
	if (message === '') message = 'Unknown error';
	return message.length > maxLength ? `${message.slice(0, maxLength)}…` : message;
}

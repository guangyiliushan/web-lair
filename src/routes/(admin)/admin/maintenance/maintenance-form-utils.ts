/**
 * Shared form-ingress helpers for the maintenance pages (J-3): the editor
 * forms submit multipart bodies, which normalize line endings to CRLF (HTML
 * spec; undici proves it in tests) while user files stay LF - fold back at
 * the ingress. `baseHash` rides as '' for "no user file yet" (null).
 */

export function parseBaseHash(raw: FormDataEntryValue | null): string | null {
	const value = (raw ?? '').toString().trim();
	return value === '' ? null : value;
}

export function parseCode(form: FormData): string {
	const raw = (form.get('code') ?? '').toString();
	return raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

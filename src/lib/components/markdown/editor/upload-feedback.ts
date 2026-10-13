import { m } from '$lib/paraglide/messages';

/**
 * Closed failure-code set -> localized copy for editor image uploads (Q10
 * asks for readable copy, including 429). Unknown codes fall back to the raw
 * code. Shared by the insert dialog and the paste/drop status strip.
 */
export function uploadErrorCopy(code: string | null): string {
	switch (code) {
		case 'too-large':
			return m.image_upload_err_too_large();
		case 'throttled':
			return m.image_upload_err_throttled();
		case 'unsupported-type':
			return m.image_upload_err_unsupported_type();
		case 'unauthorized':
			return m.image_upload_err_unauthorized();
		case 'forbidden':
			return m.image_upload_err_forbidden();
		case 'server-error':
			return m.image_upload_err_server();
		case 'network':
			return m.image_upload_err_network();
		default:
			return m.image_upload_failed({ code: code ?? '' });
	}
}

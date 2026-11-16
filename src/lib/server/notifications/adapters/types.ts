/**
 * Channel adapter contract (M6 P5, T5.4).
 *
 * `ok` carries the channel's own accept signal (Bark HTTP status, nodemailer
 * resolve). A failure says whether retrying could ever help: `permanent`
 * failures (bad credentials, blocked target, missing configuration) turn the
 * row terminal immediately, retryable ones (timeouts, 429, 5xx) follow the
 * 1m/5m/15m schedule.
 */
export interface AdapterSuccess {
	ok: true;
	/** HTTP status when the channel has one (Bark), else null. */
	responseCode: number | null;
}

export interface AdapterFailure {
	ok: false;
	permanent: boolean;
	/** Sanitized, bounded text - never a body, address or credential. */
	error: string;
	responseCode: number | null;
}

export type AdapterResult = AdapterSuccess | AdapterFailure;

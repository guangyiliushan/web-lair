import { afterEach, describe, expect, it, vi } from 'vitest';
import { notify, setNotificationSink } from './notify';

afterEach(() => setNotificationSink(null));

const event = {
	eventType: 'system.disk_high',
	eventKey: 'disk:/data',
	title: 'disk /data at 91% (warn 85%, clear 75%)',
	body: 'disk /data at 91%. Mount: /data.'
};

describe('notify() seam (M6 P4)', () => {
	it('logs through the default sink and reports no delivery', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(notify(event)).resolves.toBe('skipped');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('system.disk_high'));
		warn.mockRestore();
	});

	it('hands the event to an installed sink', async () => {
		const sink = vi.fn(async () => {});
		setNotificationSink(sink);
		await expect(notify(event)).resolves.toBe('delivered');
		expect(sink).toHaveBeenCalledWith(event);
	});

	it('swallows a failing sink (alerting never fails the probe)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		setNotificationSink(async () => {
			throw new Error('outbox unavailable');
		});
		await expect(notify(event)).resolves.toBe('failed');
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('outbox unavailable'));
		warn.mockRestore();
	});

	it('redacts a URL-bearing sink error before it reaches the log', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		setNotificationSink(async () => {
			throw new Error('POST https://hc-ping.com/1111-2222?token=SECRET failed');
		});
		await expect(notify(event)).resolves.toBe('failed');
		const line = warn.mock.calls[0]![0] as string;
		expect(line).not.toContain('SECRET');
		expect(line).toContain('https://hc-ping.com/...');
		warn.mockRestore();
	});

	it('restores the log-only default when the sink is cleared', async () => {
		const sink = vi.fn(async () => {});
		setNotificationSink(sink);
		setNotificationSink(null);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(notify(event)).resolves.toBe('skipped');
		expect(sink).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});

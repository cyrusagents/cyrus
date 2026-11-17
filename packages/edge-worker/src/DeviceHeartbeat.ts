/** Presence is independent of task activity. Never log credentials or responses. */
export class DeviceHeartbeat {
	private timer: ReturnType<typeof setInterval> | undefined;
	private pending = false;
	start() {
		if (this.timer || !process.env.CYRUS_TEAM_ID || !process.env.CYRUS_API_KEY)
			return;
		void this.ping();
		this.timer = setInterval(() => void this.ping(), 10 * 60 * 1000);
		this.timer.unref();
	}
	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
	private async ping() {
		if (this.pending) return;
		this.pending = true;
		try {
			await fetch(
				`${process.env.CYRUS_APP_URL || "https://app.atcyrus.com"}/api/devices/heartbeat`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${process.env.CYRUS_API_KEY}`,
						"X-Cyrus-Team-Id": process.env.CYRUS_TEAM_ID!,
					},
					signal: AbortSignal.timeout(15000),
				},
			);
		} catch {
			/* Offline devices retry at the next interval. */
		} finally {
			this.pending = false;
		}
	}
}

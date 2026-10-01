/**
 * The ordinary Cyrus Slack agent must never consume Slack Connect traffic.
 * Customer routing belongs to Hosted; even a verified webhook is not evidence
 * that the channel is internal. No positive classification is cached.
 */
export async function isInternalSlackChannel(
	token: string | undefined,
	teamId: string,
	channelId: string,
): Promise<boolean> {
	if (
		!token ||
		!/^T[A-Z0-9]+$/.test(teamId) ||
		!/^[CG][A-Z0-9]+$/.test(channelId)
	)
		return false;
	const signal = AbortSignal.timeout(1500);
	async function read(method: string, params: Record<string, string>) {
		const response = await fetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params),
			redirect: "error",
			signal,
		});
		if (!response.ok || !response.body)
			throw new Error("Classification unavailable");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > 65536)
					throw new Error("Classification response too large");
				chunks.push(value);
			}
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} finally {
			await reader.cancel();
		}
	}
	try {
		const [identity, info] = await Promise.all([
			read("auth.test", {}),
			read("conversations.info", { channel: channelId }),
		]);
		const channel = info?.channel;
		return (
			identity?.ok === true &&
			identity.team_id === teamId &&
			typeof identity.bot_id === "string" &&
			identity.bot_id.length > 0 &&
			info?.ok === true &&
			channel?.id === channelId &&
			channel.is_ext_shared === false &&
			channel.is_pending_ext_shared !== true &&
			(channel.is_shared === false || channel.is_org_shared === true) &&
			channel.is_member === true &&
			channel.is_archived === false
		);
	} catch {
		// Tokens, response bodies and provider errors must not enter logs/context.
		return false;
	}
}

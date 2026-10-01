export async function readBoundedJson(
	response: Response,
	maxBytes: number,
): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Empty gateway response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error("Response exceeds limit");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

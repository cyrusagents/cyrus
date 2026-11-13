import { createInterface } from "node:readline";

const resource = {
	uri: "cyrus://verification/tool-defaults",
	name: "Cyrus tool-default verification resource",
	mimeType: "text/plain",
};

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;

	switch (message.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params.protocolVersion,
					capabilities: { resources: {} },
					serverInfo: {
						name: "cyrus-tool-default-verification",
						version: "1.0.0",
					},
				},
			});
			break;
		case "resources/list":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: { resources: [resource] },
			});
			break;
		case "resources/read":
			send({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					contents: [
						{
							uri: message.params.uri,
							mimeType: resource.mimeType,
							text: "resource fixture",
						},
					],
				},
			});
			break;
		case "ping":
			send({ jsonrpc: "2.0", id: message.id, result: {} });
			break;
		default:
			send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32601, message: "Method not found" },
			});
	}
});

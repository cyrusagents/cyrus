import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ApiResponse, TestMcpPayload } from "../types.js";

const TEST_TIMEOUT_MS = 25_000; // 25s (edge request timeout is 30s)
const CLOSE_TIMEOUT_MS = 5_000; // 5s for graceful close

/**
 * Handle MCP connection test
 * Spawns the MCP server, connects via the MCP protocol, and discovers available tools.
 */
export async function handleTestMcp(
	payload: TestMcpPayload,
): Promise<ApiResponse> {
	try {
		if (!payload.transportType) {
			return {
				success: false,
				error: "MCP test requires transport type",
			};
		}

		if (payload.transportType === "stdio") {
			if (!payload.command) {
				return {
					success: false,
					error: "MCP stdio transport requires a command",
				};
			}
			return await testStdioMcp(payload);
		}

		if (payload.transportType === "http" || payload.transportType === "sse") {
			if (!payload.serverUrl) {
				return {
					success: false,
					error: "MCP HTTP/SSE transport requires a server URL",
				};
			}
			return await testHttpMcp(payload);
		}

		return {
			success: false,
			error: `Unsupported transport type: ${payload.transportType}`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error ? error.message : "MCP connection test failed",
		};
	}
}

/**
 * Test a stdio MCP server by spawning the process, connecting, and listing tools.
 */
async function testStdioMcp(payload: TestMcpPayload): Promise<ApiResponse> {
	const args = payload.commandArgs
		? [...payload.commandArgs]
				.sort((a, b) => a.order - b.order)
				.map((a) => a.value)
		: [];

	// Start with the default safe environment (PATH, HOME, etc.)
	const env = getDefaultEnvironment();

	// Layer on user-provided env vars
	if (payload.envVars) {
		for (const { key, value } of payload.envVars) {
			env[key] = value;
		}
	}

	const transport = new StdioClientTransport({
		command: payload.command!,
		args,
		env,
		stderr: "pipe",
	});

	return await connectAndDiscover(transport, payload.command!);
}

/**
 * Test an HTTP/SSE MCP server by connecting and listing tools.
 */
async function testHttpMcp(payload: TestMcpPayload): Promise<ApiResponse> {
	// Build headers, substituting env vars
	const headers: Record<string, string> = {};
	if (payload.headers) {
		for (const { name, value } of payload.headers) {
			headers[name] = value;
		}
	}

	// Substitute ${VAR} placeholders in URL and headers
	let url = payload.serverUrl!;
	if (payload.envVars) {
		for (const { key, value } of payload.envVars) {
			const placeholder = `\${${key}}`;
			url = url.replaceAll(placeholder, value);
			for (const headerName of Object.keys(headers)) {
				const current = headers[headerName];
				if (current !== undefined) {
					headers[headerName] = current.replaceAll(placeholder, value);
				}
			}
		}
	}

	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: {
			headers,
		},
	});

	return await connectAndDiscover(transport, url);
}

/**
 * Connect to an MCP server via the given transport, list tools, and return the result.
 */
async function connectAndDiscover(
	transport: Transport,
	fallbackName: string,
): Promise<ApiResponse> {
	const client = new Client({
		name: "miko-mcp-tester",
		version: "1.0.0",
	});

	try {
		await withTimeout(client.connect(transport), "Connection timed out");

		const toolsResult = await withTimeout(
			client.listTools(),
			"Tool listing timed out",
		);

		const tools = toolsResult.tools.map((t) => ({
			name: t.name,
			description: t.description || "",
		}));

		const serverVersion = client.getServerVersion();

		return {
			success: true,
			message: `MCP connection test successful — discovered ${tools.length} tool(s)`,
			data: {
				tools,
				serverInfo: {
					name: serverVersion?.name || fallbackName,
					version: serverVersion?.version || "unknown",
					protocol: "mcp/1.0",
				},
			},
		};
	} finally {
		try {
			await withTimeout(client.close(), "Close timed out", CLOSE_TIMEOUT_MS);
		} catch {
			// Best-effort cleanup — if close hangs, let it go
		}
	}
}

/** Race a promise against a timeout, clearing the timer on settlement. */
function withTimeout<T>(
	promise: Promise<T>,
	message: string,
	ms: number = TEST_TIMEOUT_MS,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

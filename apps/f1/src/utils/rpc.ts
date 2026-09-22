/**
 * JSON-RPC client utilities for F1 CLI
 */

import { error, gray } from "./colors.js";

/**
 * JSON-RPC request structure
 */
interface JsonRpcRequest {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
	id: number;
}

/**
 * JSON-RPC response structure
 */
interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	result?: T;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
	id: number;
}

/**
 * Get the RPC endpoint URL
 */
export function getRpcUrl(): string {
	const port = process.env.ATMIKO_PORT || "3600";
	return `http://localhost:${port}/cli/rpc`;
}

/**
 * Make a JSON-RPC call to the F1 server
 */
export async function rpcCall<T = unknown>(
	method: string,
	params?: unknown,
): Promise<T> {
	const url = getRpcUrl();
	const requestId = Date.now();

	const request: JsonRpcRequest = {
		jsonrpc: "2.0",
		method,
		params: params as Record<string, unknown> | undefined,
		id: requestId,
	};

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = (await response.json()) as JsonRpcResponse<T>;

		if (data.error) {
			throw new Error(`RPC Error (${data.error.code}): ${data.error.message}`);
		}

		if (data.result === undefined) {
			throw new Error("RPC response missing result");
		}

		return data.result;
	} catch (err) {
		if (err instanceof Error) {
			if (err.message.includes("ECONNREFUSED")) {
				console.error(error("Cannot connect to F1 server"));
				console.error(gray(`  Tried: ${url}`));
				console.error(gray("  Make sure the F1 server is running"));
				process.exit(1);
			}
			throw err;
		}
		throw new Error("Unknown error during RPC call");
	}
}

/**
 * Print the RPC URL for debugging
 */
export function printRpcUrl(): void {
	console.error(gray(`RPC: ${getRpcUrl()}`));
}

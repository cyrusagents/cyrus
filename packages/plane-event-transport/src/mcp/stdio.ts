#!/usr/bin/env node
/**
 * Stdio entry point for the Plane tools MCP server (see PlaneToolsServer).
 * Configured by the PLANE_* variables that planeToolsMcpServerConfig sets.
 */

// Stdout carries the MCP protocol; send every log line to stderr.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const { StdioServerTransport } = await import(
	"@modelcontextprotocol/sdk/server/stdio.js"
);
const { PlaneApiClient } = await import("../PlaneApiClient.js");
const { createPlaneToolsServer } = await import("./PlaneToolsServer.js");

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`Plane tools MCP server: ${name} is not set`);
		process.exit(1);
	}
	return value;
}

const api = new PlaneApiClient({
	baseUrl: required("PLANE_BASE_URL").replace(/\/+$/, ""),
	workspaceSlug: required("PLANE_WORKSPACE_SLUG"),
	clientId: required("PLANE_CLIENT_ID"),
	clientSecret: required("PLANE_CLIENT_SECRET"),
	appInstallationId: required("PLANE_APP_INSTALLATION_ID"),
});

await createPlaneToolsServer(api).connect(new StdioServerTransport());

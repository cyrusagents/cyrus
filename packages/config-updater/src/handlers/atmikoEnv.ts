import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiResponse, AtmikoEnvPayload } from "../types.js";

/**
 * Handle Atmiko environment variables update
 * Primarily used to update/provide the Claude API token
 */
export async function handleAtmikoEnv(
	payload: AtmikoEnvPayload,
	atmikoHome: string,
): Promise<ApiResponse> {
	try {
		// Validate payload
		if (!payload || typeof payload !== "object") {
			return {
				success: false,
				error: "Environment variables update requires valid data",
				details:
					"Payload must be an object containing environment variable key-value pairs.",
			};
		}

		// Extract environment variables from payload
		// The payload may have a 'variables' key containing the env vars,
		// or the env vars may be directly in the payload
		const envVarsSource = payload.variables || payload;
		const envVars = Object.entries(envVarsSource).filter(
			([key, value]) =>
				value !== undefined &&
				typeof value === "string" &&
				!["variables", "restartAtmiko", "backupEnv"].includes(key),
		) as [string, string][];

		if (envVars.length === 0) {
			return {
				success: false,
				error: "No environment variables to update",
				details:
					"At least one environment variable must be provided in the request.",
			};
		}

		const envPath = join(atmikoHome, ".env");

		// Ensure the .atmiko directory exists
		const envDir = dirname(envPath);
		if (!existsSync(envDir)) {
			mkdirSync(envDir, { recursive: true });
		}

		// Read existing env file if it exists
		const existingEnv: Record<string, string> = {};
		if (existsSync(envPath)) {
			try {
				const content = readFileSync(envPath, "utf-8");
				const lines = content.split("\n");

				for (const line of lines) {
					const trimmed = line.trim();
					// Skip empty lines and comments
					if (!trimmed || trimmed.startsWith("#")) {
						continue;
					}

					const equalIndex = trimmed.indexOf("=");
					if (equalIndex > 0) {
						const key = trimmed.substring(0, equalIndex);
						const value = trimmed.substring(equalIndex + 1);
						existingEnv[key] = value;
					}
				}
			} catch {
				// Ignore errors reading existing file - we'll create a new one
			}
		}

		// Merge new variables (new values override existing ones)
		for (const [key, value] of envVars) {
			if (value !== undefined) {
				existingEnv[key] = value;
			}
		}

		// Build new env file content
		const envContent = Object.entries(existingEnv)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n");

		// Backup existing env file if requested
		if (payload.backupEnv && existsSync(envPath)) {
			try {
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
				const backupPath = join(atmikoHome, `.env.backup-${timestamp}`);
				const existingEnvFile = readFileSync(envPath, "utf-8");
				writeFileSync(backupPath, existingEnvFile, "utf-8");
			} catch (backupError) {
				// Log but don't fail - backup is not critical
				console.warn(
					`Failed to backup env: ${backupError instanceof Error ? backupError.message : String(backupError)}`,
				);
			}
		}

		// Write env file
		try {
			writeFileSync(envPath, `${envContent}\n`, "utf-8");

			return {
				success: true,
				message: "Environment variables updated successfully",
				data: {
					envPath,
					variablesUpdated: envVars.map(([key]) => key),
					restartAtmiko: payload.restartAtmiko || false,
				},
			};
		} catch (error) {
			return {
				success: false,
				error: "Failed to save environment variables",
				details: `Could not write to ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	} catch (error) {
		return {
			success: false,
			error: "Environment variables update failed",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

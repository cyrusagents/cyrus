import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ApiResponse, CheckGhData, CheckGhPayload } from "../types.js";

const execAsync = promisify(exec);

/**
 * Check if GitHub CLI (gh) is installed and authenticated
 *
 * @param _payload - Empty payload (no parameters needed)
 * @param _atmikoHome - Atmiko home directory (not used)
 * @returns ApiResponse with installation and authentication status
 */
export async function handleCheckGh(
	_payload: CheckGhPayload,
	_atmikoHome: string,
): Promise<ApiResponse> {
	try {
		// Check if gh is installed
		let isInstalled = false;
		try {
			await execAsync("gh --version");
			isInstalled = true;
		} catch {
			// gh command not found
			isInstalled = false;
		}

		// Check if gh is authenticated (only if installed)
		let isAuthenticated = false;
		if (isInstalled) {
			try {
				// Run 'gh auth status' and check exit code
				await execAsync("gh auth status");
				isAuthenticated = true;
			} catch {
				// gh auth status failed (not authenticated)
				isAuthenticated = false;
			}
		}

		const data: CheckGhData = {
			isInstalled,
			isAuthenticated,
		};

		return {
			success: true,
			message: "GitHub CLI check completed",
			data,
		};
	} catch (error) {
		return {
			success: false,
			error: "Failed to check GitHub CLI status",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

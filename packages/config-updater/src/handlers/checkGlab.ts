import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ApiResponse, CheckGlabData, CheckGlabPayload } from "../types.js";

const execAsync = promisify(exec);

/**
 * Check if GitLab CLI (glab) is installed and authenticated
 *
 * @param _payload - Empty payload (no parameters needed)
 * @param _mikoHome - Miko home directory (not used)
 * @returns ApiResponse with installation and authentication status
 */
export async function handleCheckGlab(
	_payload: CheckGlabPayload,
	_mikoHome: string,
): Promise<ApiResponse> {
	try {
		// Check if glab is installed
		let isInstalled = false;
		try {
			await execAsync("glab --version");
			isInstalled = true;
		} catch {
			// glab command not found
			isInstalled = false;
		}

		// Check if glab is authenticated (only if installed)
		let isAuthenticated = false;
		if (isInstalled) {
			try {
				// Run 'glab auth status' and check exit code
				await execAsync("glab auth status");
				isAuthenticated = true;
			} catch {
				// glab auth status failed (not authenticated)
				isAuthenticated = false;
			}
		}

		const data: CheckGlabData = {
			isInstalled,
			isAuthenticated,
		};

		return {
			success: true,
			message: "GitLab CLI check completed",
			data,
		};
	} catch (error) {
		return {
			success: false,
			error: "Failed to check GitLab CLI status",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

#!/usr/bin/env node
/**
 * Manual test script for the /api/check-gh endpoint
 *
 * This script demonstrates how to use the check-gh endpoint to verify
 * whether the GitHub CLI (gh) is installed and authenticated.
 *
 * Usage:
 *   node test-scripts/test-check-gh.js
 *
 * Note: This requires a running EdgeWorker server with ConfigUpdater registered
 * and a valid ATMIKO_API_KEY environment variable set.
 */

import { handleCheckGh } from "../dist/handlers/checkGh.js";

async function testCheckGh() {
	console.log("Testing handleCheckGh handler...\n");

	try {
		const result = await handleCheckGh({}, "/tmp/test-atmiko-home");

		console.log("Result:", JSON.stringify(result, null, 2));

		if (result.success) {
			console.log("\n✅ Handler executed successfully");
			console.log(`   - GitHub CLI installed: ${result.data.isInstalled}`);
			console.log(
				`   - GitHub CLI authenticated: ${result.data.isAuthenticated}`,
			);

			if (!result.data.isInstalled) {
				console.log("\n💡 To install GitHub CLI:");
				console.log("   - macOS: brew install gh");
				console.log(
					"   - Linux: https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
				);
				console.log("   - Windows: https://github.com/cli/cli/releases");
			} else if (!result.data.isAuthenticated) {
				console.log("\n💡 To authenticate GitHub CLI:");
				console.log("   Run: gh auth login");
			}
		} else {
			console.log("\n❌ Handler failed");
			console.log(`   Error: ${result.error}`);
			if (result.details) {
				console.log(`   Details: ${result.details}`);
			}
		}
	} catch (error) {
		console.error("❌ Unexpected error:", error);
		process.exit(1);
	}
}

testCheckGh();

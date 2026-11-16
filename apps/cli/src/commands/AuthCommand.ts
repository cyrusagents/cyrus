import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { resolve } from "node:path";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import { BaseCommand } from "./ICommand.js";

/**
 * Auth command - authenticate with Cyrus Pro plan using auth key
 */
export class AuthCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		// Get auth key from command line arguments
		const authKey = args[0];

		if (
			!authKey ||
			typeof authKey !== "string" ||
			authKey.trim().length === 0
		) {
			this.logError("Error: Auth key is required");
			console.log("\nUsage: cyrus auth <auth-key>");
			console.log(`\nGet your auth key from: ${getCyrusAppUrl()}/devices`);
			process.exit(1);
		}

		console.log("\n🔑 Authenticating with Cyrus...");
		this.logDivider();

		try {
			// Import ConfigApiClient
			const { ConfigApiClient } = await import(
				"cyrus-cloudflare-tunnel-client"
			);

			// Call the config API to get credentials
			console.log("Validating auth key...");
			const configResponse = await ConfigApiClient.getConfig(authKey, {
				hostname: hostname(),
				platform: platform(),
				arch: arch(),
				release: release(),
				cpu: cpus()[0]?.model,
				cores: Math.max(1, cpus().length),
				memory: totalmem(),
				version: this.app.version,
			});

			if (!ConfigApiClient.isValid(configResponse)) {
				this.logError("Authentication failed");
				console.error(configResponse.error || "Invalid response from server");
				console.log("\nPlease verify your auth key is correct.");
				console.log(`Get your auth key from: ${getCyrusAppUrl()}/devices`);
				process.exit(1);
			}

			this.logSuccess("Authentication successful!");

			// Ensure CYRUS_HOME directory exists
			if (!existsSync(this.app.cyrusHome)) {
				mkdirSync(this.app.cyrusHome, { recursive: true });
			}

			// Replace pairing credentials without deleting provider tokens or local settings.
			const envPath = resolve(this.app.cyrusHome, ".env");
			const existingEnv = existsSync(envPath)
				? readFileSync(envPath, "utf-8")
				: "";
			const preservedEnv = existingEnv.replace(
				/^[\t ]*(?:export\s+)?(?:CLOUDFLARE_TOKEN|CYRUS_API_KEY|CYRUS_SETUP_PENDING|CYRUS_TEAM_ID|CYRUS_DEVICE_ID|CYRUS_SERVER_PORT|CYRUS_APP_URL)\s*=.*(?:\r?\n|$)/gm,
				"",
			);
			const envContent = `${preservedEnv.trimEnd()}\n# Cyrus Authentication Credentials
# Generated on ${new Date().toISOString()}
CLOUDFLARE_TOKEN=${configResponse.config!.cloudflareToken}
CYRUS_API_KEY=${configResponse.config!.apiKey}
CYRUS_APP_URL=${getCyrusAppUrl()}
CYRUS_SETUP_PENDING=true
${configResponse.config!.teamId ? `CYRUS_TEAM_ID=${configResponse.config!.teamId}\n` : ""}${configResponse.config!.deviceId ? `CYRUS_DEVICE_ID=${configResponse.config!.deviceId}\n` : ""}
${configResponse.config!.serverPort === undefined ? "" : `CYRUS_SERVER_PORT=${configResponse.config!.serverPort}\n`}
`;

			writeFileSync(envPath, envContent, { encoding: "utf-8", mode: 0o600 });
			chmodSync(envPath, 0o600);
			this.logSuccess(`Credentials saved to ${envPath}`);

			// Reload environment variables to pick up CYRUS_SETUP_PENDING
			// dotenv does not clear absent keys when switching to a legacy registration.
			for (const name of [
				"CYRUS_TEAM_ID",
				"CYRUS_DEVICE_ID",
				"CYRUS_SERVER_PORT",
			]) {
				delete process.env[name];
			}
			const dotenv = await import("dotenv");
			dotenv.config({ path: envPath, override: true });

			console.log("\n✨ Setup complete! Starting Cyrus...");
			this.logDivider();
			console.log();

			// Start the edge app with the new configuration
			// Import StartCommand to avoid circular dependency
			const { StartCommand } = await import("./StartCommand.js");
			const startCommand = new StartCommand(this.app);
			await startCommand.execute([]);
		} catch (error) {
			this.logError("Authentication failed:");
			console.error((error as Error).message);
			console.log(
				"\nPlease try again or contact support if the issue persists.",
			);
			process.exit(1);
		}
	}
}

/**
 * Default Cyrus app base URL
 * Can be overridden via CYRUS_APP_URL environment variable for preview environments
 */
export const DEFAULT_CYRUS_APP_URL = "https://app.atcyrus.com";

/**
 * Get the Cyrus app base URL from environment variable or use default
 * @returns The Cyrus app base URL (e.g., "https://app.atcyrus.com")
 */
export function getCyrusAppUrl(): string {
	return process.env.CYRUS_APP_URL || DEFAULT_CYRUS_APP_URL;
}

/**
 * Config API response from cyrus-hosted
 */
export interface ConfigApiResponse {
	success: boolean;
	config?: {
		cloudflareToken: string;
		apiKey: string;
		/** Optional hosted-managed listener port; absent preserves legacy behavior. */
		serverPort?: number;
	};
	error?: string;
}

/**
 * Client for retrieving configuration from cyrus-hosted
 * Authenticates using auth keys provided during onboarding
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Static utility client keeps existing callsites stable.
export class ConfigApiClient {
	/**
	 * Get the config API URL, respecting CYRUS_APP_URL environment variable
	 */
	private static getConfigApiUrl(): string {
		return `${getCyrusAppUrl()}/api/config`;
	}

	/**
	 * Retrieve configuration using an auth key
	 * @param authKey - The auth key provided during onboarding
	 * @returns Configuration containing Cloudflare tunnel token and API key
	 */
	static async getConfig(authKey: string): Promise<ConfigApiResponse> {
		try {
			// Validate auth key
			if (
				!authKey ||
				typeof authKey !== "string" ||
				authKey.trim().length === 0
			) {
				return {
					success: false,
					error: "Auth key is required",
				};
			}

			// Call config API with auth key
			const url = `${ConfigApiClient.getConfigApiUrl()}?auth_key=${encodeURIComponent(authKey)}`;
			const response = await fetch(url, {
				headers: { "X-Cyrus-Config-Capabilities": "self-host-port-v1" },
			});

			if (!response.ok) {
				const errorText = await response.text();
				return {
					success: false,
					error: `Config API request failed: ${response.status} ${response.statusText} - ${errorText}`,
				};
			}

			const data = (await response.json()) as ConfigApiResponse;

			// Validate response structure
			if (!data.success || !data.config) {
				return {
					success: false,
					error: data.error || "Invalid response format from config API",
				};
			}

			// Validate required fields
			if (!data.config.cloudflareToken || !data.config.apiKey) {
				return {
					success: false,
					error: "Config API response missing required fields",
				};
			}
			if (!ConfigApiClient.isValid(data)) {
				return {
					success: false,
					error: "Config API response contains an invalid listener port",
				};
			}

			return data;
		} catch (error) {
			if (error instanceof Error) {
				return {
					success: false,
					error: `Failed to retrieve config: ${error.message}`,
				};
			}
			return {
				success: false,
				error: "Failed to retrieve config: Unknown error",
			};
		}
	}

	/**
	 * Check if a config response is valid and usable
	 */
	static isValid(response: ConfigApiResponse): boolean {
		return (
			response.success &&
			!!response.config?.cloudflareToken &&
			!!response.config?.apiKey &&
			(response.config.serverPort === undefined ||
				(typeof response.config.serverPort === "number" &&
					Number.isInteger(response.config.serverPort) &&
					response.config.serverPort >= 1 &&
					response.config.serverPort <= 65535))
		);
	}
}

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface GitHubAppTokenProviderConfig {
	appId: string;
	/**
	 * Optional default installation id used when getToken() is called without
	 * an override (e.g. from GITHUB_APP_INSTALLATION_ID). Prefer passing the
	 * webhook payload's installation.id for multi-org self-hosting.
	 */
	installationId?: string;
	privateKeyPath: string;
	/** GitHub API base URL (default: https://api.github.com) */
	apiBaseUrl?: string;
}

interface CachedInstallationToken {
	token: string;
	expiresAt: number;
}

/**
 * Mints and caches GitHub App installation tokens for self-hosted users.
 *
 * Uses the App's private key to sign a JWT, then exchanges it for a
 * short-lived installation access token via the GitHub API.
 * Tokens are cached per installation id and refreshed 5 minutes before expiry.
 */
export class GitHubAppTokenProvider {
	private config: GitHubAppTokenProviderConfig;
	private cache = new Map<string, CachedInstallationToken>();
	private privateKeyPromise: Promise<string> | null = null;

	constructor(config: GitHubAppTokenProviderConfig) {
		this.config = config;
	}

	/**
	 * Get a valid installation access token.
	 *
	 * @param installationId - Installation to mint for. Falls back to the
	 *   config default when omitted. Throws if neither is available.
	 */
	async getToken(installationId?: string): Promise<string> {
		const resolvedId = installationId ?? this.config.installationId;
		if (!resolvedId) {
			throw new Error(
				"[GitHubAppTokenProvider] No installation id: pass getToken(installationId) or set a default in config",
			);
		}

		const cached = this.cache.get(resolvedId);
		// Refresh 5 minutes before expiry
		if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
			return cached.token;
		}

		const pem = await this.loadPrivateKey();
		const jwt = createAppJwt(this.config.appId, pem);
		const apiBase = this.config.apiBaseUrl ?? "https://api.github.com";

		const response = await fetch(
			`${apiBase}/app/installations/${resolvedId}/access_tokens`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);

		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`[GitHubAppTokenProvider] Failed to create installation token: ${response.status} ${response.statusText} - ${body}`,
			);
		}

		const data = (await response.json()) as {
			token: string;
			expires_at: string;
		};

		this.cache.set(resolvedId, {
			token: data.token,
			expiresAt: new Date(data.expires_at).getTime(),
		});

		return data.token;
	}

	private loadPrivateKey(): Promise<string> {
		if (!this.privateKeyPromise) {
			this.privateKeyPromise = readFile(this.config.privateKeyPath, "utf-8");
		}
		return this.privateKeyPromise;
	}
}

/**
 * Create a JWT for GitHub App authentication.
 * Uses Node's native crypto — no external JWT library needed.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function createAppJwt(appId: string, privateKey: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 10 * 60,
			iss: appId,
		}),
	).toString("base64url");

	const sign = createSign("RSA-SHA256");
	sign.update(`${header}.${payload}`);
	const signature = sign.sign(privateKey, "base64url");

	return `${header}.${payload}.${signature}`;
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	extractOwnerFromGitHubUrl,
	type GitHubInstallationToken,
	GitHubTokenStore,
} from "miko-core";
import { GitHubAppTokenProvider } from "miko-github-event-transport";
import {
	ensureGhTokenResolver,
	ensureGitHubCredentialHelper,
} from "./handlers/githubTokens.js";

export interface SelfHostedGitHubAuthLogger {
	info?: (message: string, ...args: unknown[]) => void;
	warn?: (message: string, error?: Error) => void;
	debug?: (message: string, ...args: unknown[]) => void;
}

export interface EnsureSelfHostedGitHubAuthResult {
	/** True when App credentials were present and minting was attempted */
	attempted: boolean;
	/** Tokens written to the store (0 when mint failed or no installs) */
	tokensCount: number;
	/** Provider used for minting, if App credentials exist */
	provider: GitHubAppTokenProvider | null;
}

/**
 * Create a GitHubAppTokenProvider when self-hosted App credentials exist
 * (`GITHUB_APP_ID` + `<mikoHome>/github-app.pem`). Returns null otherwise —
 * GitHub App is optional (Linear-only / local gh setups keep working).
 */
export function createSelfHostedGitHubAppTokenProvider(
	mikoHome: string,
	env: NodeJS.ProcessEnv = process.env,
): GitHubAppTokenProvider | null {
	const appId = env.GITHUB_APP_ID;
	const pemPath = join(mikoHome, "github-app.pem");
	if (!appId || !existsSync(pemPath)) return null;
	return new GitHubAppTokenProvider({
		appId,
		installationId: env.GITHUB_APP_INSTALLATION_ID || undefined,
		privateKeyPath: pemPath,
	});
}

/**
 * Mint installation tokens for known App installs and populate
 * GitHubTokenStore, then wire the git credential helper + gh resolver.
 *
 * Preferred path for self-hosted git fetch/push and `gh` when App
 * credentials exist. Non-fatal when mint fails — callers fall back to
 * local git/gh credentials.
 */
export async function ensureSelfHostedGitHubAuth(
	mikoHome: string,
	options: {
		logger?: SelfHostedGitHubAuthLogger;
		/** Reuse an existing provider (EdgeWorker) instead of creating one */
		provider?: GitHubAppTokenProvider | null;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<EnsureSelfHostedGitHubAuthResult> {
	const logger = options.logger;
	const env = options.env ?? process.env;
	const provider =
		options.provider === undefined
			? createSelfHostedGitHubAppTokenProvider(mikoHome, env)
			: options.provider;

	const store = new GitHubTokenStore(mikoHome);

	if (!provider) {
		// Still ensure helpers when a cloud-pushed token file already exists.
		if (existsSync(store.filePath)) {
			try {
				ensureGitHubCredentialHelper(mikoHome);
				ensureGhTokenResolver(mikoHome);
			} catch (error) {
				logger?.warn?.(
					"Failed to configure GitHub auth scripts from existing token store",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return { attempted: false, tokensCount: 0, provider: null };
	}

	let tokens: GitHubInstallationToken[] = [];
	try {
		tokens = await provider.mintInstallationTokens();
		if (tokens.length > 0) {
			store.save(tokens);
			logger?.info?.(
				`Populated GitHub token store with ${tokens.length} App installation token(s)`,
			);
		} else {
			logger?.warn?.(
				"GitHub App credentials present but no installations found to mint",
			);
		}
	} catch (error) {
		logger?.warn?.(
			"Failed to mint GitHub App installation tokens for token store (will fall back to local git/gh credentials)",
			error instanceof Error ? error : new Error(String(error)),
		);
	}

	try {
		ensureGitHubCredentialHelper(mikoHome);
		ensureGhTokenResolver(mikoHome);
		logger?.info?.(
			"✅ GitHub auth scripts configured (credential helper + gh resolver)",
		);
	} catch (error) {
		logger?.warn?.(
			"Failed to configure GitHub auth scripts (non-fatal)",
			error instanceof Error ? error : new Error(String(error)),
		);
	}

	return {
		attempted: true,
		tokensCount: tokens.length,
		provider,
	};
}

/**
 * Resolve a token suitable for cloning/fetching a GitHub repo URL.
 * Prefers an org-matched (or single-install fallback) store entry.
 */
export function resolveGitHubTokenForRepoUrl(
	mikoHome: string,
	repoUrl: string,
): string | undefined {
	const store = new GitHubTokenStore(mikoHome);
	return (
		store.getTokenForRepoUrl(repoUrl) ?? store.getFallbackToken() ?? undefined
	);
}

/**
 * Build an HTTPS clone URL that embeds an installation token so `git clone`
 * works for private repos without relying solely on the credential helper
 * (useful for one-shot CLI clones before helpers may be wired).
 *
 * Returns null when the URL is not a github.com HTTP(S)/scp URL we can rewrite.
 */
export function buildAuthenticatedGitHubCloneUrl(
	repoUrl: string,
	token: string,
): string | null {
	const owner = extractOwnerFromGitHubUrl(repoUrl);
	if (!owner) return null;

	const trimmed = repoUrl.trim().replace(/\.git$/i, "");
	let repoName: string | undefined;

	const scp = trimmed.match(/^[\w.-]+@github\.com:([^/]+)\/(.+)$/i);
	if (scp) {
		repoName = scp[2];
	} else {
		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
			? trimmed
			: `https://${trimmed}`;
		try {
			const parsed = new URL(withScheme);
			if (parsed.hostname.toLowerCase() !== "github.com") return null;
			const segments = parsed.pathname.split("/").filter(Boolean);
			repoName = segments[1];
		} catch {
			return null;
		}
	}

	if (!repoName) return null;
	return `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`;
}

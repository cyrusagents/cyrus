// Node 18+ globals — available at runtime but not in ES2022 lib typings
declare class AbortSignal {
	static timeout(ms: number): AbortSignal;
}
declare function fetch(
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

import { createLogger, type ILogger } from "../logging/index.js";

/**
 * Known webhook source IPs/CIDRs for supported providers.
 *
 * Linear: https://linear.app/developers/webhooks#securing-webhooks
 * GitHub: https://api.github.com/meta (hooks field)
 * GitLab: https://docs.gitlab.com/ee/user/gitlab_com/#ip-range
 */
export const LINEAR_WEBHOOK_IPS = [
	"35.231.147.226",
	"35.243.134.228",
	"34.140.253.14",
	"34.38.87.206",
	"34.134.222.122",
	"35.222.25.142",
] as const;

/**
 * Fallback GitHub webhook CIDRs (from /meta API as of 2025).
 * These are used when the /meta API is unavailable.
 */
export const GITHUB_WEBHOOK_CIDRS_FALLBACK = [
	"192.30.252.0/22",
	"185.199.108.0/22",
	"140.82.112.0/20",
	"143.55.64.0/20",
] as const;

/**
 * GitLab.com webhook source IPs.
 * https://docs.gitlab.com/ee/user/gitlab_com/#ip-range
 */
export const GITLAB_WEBHOOK_CIDRS = [
	"34.74.90.64/28",
	"34.74.226.0/24",
] as const;

export type WebhookProvider = "linear" | "github" | "gitlab";

/**
 * Parse a CIDR notation string into a base IP (as 32-bit number) and mask.
 * Supports both plain IPs ("1.2.3.4") and CIDR notation ("1.2.3.4/24").
 */
export function parseCidr(cidr: string): { base: number; mask: number } {
	const slashIdx = cidr.indexOf("/");
	const ip = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx);
	const prefixLen =
		slashIdx === -1 ? 32 : Number.parseInt(cidr.slice(slashIdx + 1), 10);

	const octets = ip.split(".").map((o) => Number.parseInt(o, 10));
	const ipNum =
		((octets[0]! << 24) |
			(octets[1]! << 16) |
			(octets[2]! << 8) |
			octets[3]!) >>>
		0;

	// Create mask: e.g. /24 → 0xFFFFFF00
	const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;

	return { base: (ipNum & mask) >>> 0, mask };
}

/**
 * Convert an IPv4 address string to a 32-bit unsigned integer.
 */
export function ipToNumber(ip: string): number {
	const octets = ip.split(".").map((o) => Number.parseInt(o, 10));
	return (
		((octets[0]! << 24) |
			(octets[1]! << 16) |
			(octets[2]! << 8) |
			octets[3]!) >>>
		0
	);
}

/**
 * Check if an IPv4 address matches a CIDR range or exact IP.
 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
	const { base, mask } = parseCidr(cidr);
	const ipNum = ipToNumber(ip);
	return (ipNum & mask) >>> 0 === base;
}

/**
 * Normalize an IP address by stripping IPv4-mapped IPv6 prefix (::ffff:).
 * Returns the raw IPv4 string if it was mapped, otherwise returns the original.
 */
export function normalizeIp(ip: string): string {
	if (ip.startsWith("::ffff:")) {
		return ip.slice(7);
	}
	return ip;
}

/**
 * Check if an IP address matches any entry in an allowlist of IPs/CIDRs.
 */
export function ipMatchesAllowlist(
	ip: string,
	allowlist: readonly string[],
): boolean {
	const normalizedIp = normalizeIp(ip);

	// Only validate IPv4 addresses (IPv6 webhooks are uncommon for these providers)
	if (!normalizedIp.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
		return false;
	}

	return allowlist.some((entry) => ipMatchesCidr(normalizedIp, entry));
}

/**
 * Options for creating a WebhookIpValidator
 */
export interface WebhookIpValidatorOptions {
	/** Enable or disable IP validation globally */
	enabled?: boolean;
	/** Custom allowlists to merge with (or replace) defaults */
	customAllowlists?: Partial<Record<WebhookProvider, readonly string[]>>;
	/** Logger instance */
	logger?: ILogger;
}

/**
 * Validates webhook source IPs against known provider allowlists.
 *
 * For GitHub, call `refreshGitHubAllowlist()` after construction to fetch
 * the latest CIDRs from the /meta API. Falls back to a static list if
 * the API is unavailable.
 */
export class WebhookIpValidator {
	private allowlists: Record<WebhookProvider, readonly string[]>;
	private enabled: boolean;
	private logger: ILogger;

	constructor(options: WebhookIpValidatorOptions = {}) {
		this.enabled = options.enabled ?? true;
		this.logger =
			options.logger ?? createLogger({ component: "WebhookIpValidator" });

		const custom = options.customAllowlists ?? {};
		this.allowlists = {
			linear: custom.linear ?? [...LINEAR_WEBHOOK_IPS],
			github: custom.github ?? [...GITHUB_WEBHOOK_CIDRS_FALLBACK],
			gitlab: custom.gitlab ?? [...GITLAB_WEBHOOK_CIDRS],
		};
	}

	/**
	 * Fetch the latest GitHub webhook CIDRs from the /meta API and update the allowlist.
	 * Falls back to the static fallback list on failure.
	 */
	async refreshGitHubAllowlist(): Promise<void> {
		try {
			const response = await fetch("https://api.github.com/meta", {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				this.logger.warn(
					`GitHub /meta API returned ${response.status}, using fallback CIDRs`,
				);
				return;
			}

			const data = (await response.json()) as { hooks?: string[] };
			if (data.hooks && Array.isArray(data.hooks) && data.hooks.length > 0) {
				this.allowlists.github = data.hooks;
				this.logger.info(
					`Refreshed GitHub webhook allowlist: ${data.hooks.length} CIDRs`,
				);
			}
		} catch (error) {
			this.logger.warn(
				"Failed to fetch GitHub /meta API, using fallback CIDRs",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Validate an IP address against the allowlist for the given provider.
	 * Returns true if:
	 * - IP validation is disabled
	 * - The IP matches the provider's allowlist
	 *
	 * Returns false if the IP does not match.
	 */
	validate(ip: string, provider: WebhookProvider): boolean {
		if (!this.enabled) {
			return true;
		}

		const allowlist = this.allowlists[provider];
		if (!allowlist || allowlist.length === 0) {
			this.logger.warn(
				`No allowlist configured for provider ${provider}, allowing request`,
			);
			return true;
		}

		const isAllowed = ipMatchesAllowlist(ip, allowlist);
		if (!isAllowed) {
			this.logger.warn(
				`Rejected webhook from ${normalizeIp(ip)} — not in ${provider} allowlist`,
			);
		}

		return isAllowed;
	}

	/**
	 * Whether IP validation is currently enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Get the current allowlist for a provider (for debugging/logging).
	 */
	getAllowlist(provider: WebhookProvider): readonly string[] {
		return this.allowlists[provider];
	}
}

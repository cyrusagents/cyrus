/**
 * HTTP client for the BRI-3235 authority work-lease API.
 *
 * Handles the adopt → immediate-get readback protocol that Cyrus must complete
 * before any issue-state transition or workspace creation. Both operations go
 * to the same authority endpoint (CYRUS_WORK_LEASE_URL) with a Bearer token.
 *
 * Security invariants:
 *   - The bearer token (CYRUS_WORK_LEASE_TOKEN) is NEVER logged, serialized,
 *     or included in error messages. All token handling is internal.
 *   - Any 4xx/5xx, timeout, non-JSON, oversized body, ok:false, or binding
 *     mismatch causes WorkLeaseError to be thrown. Callers must fail closed.
 */

import type { ILogger } from "cyrus-core";
import type { HandoffMarkerData } from "./HandoffMarkerParser.js";

/** Hard limit to guard against authority returning huge bodies. */
const MAX_BODY_BYTES = 1_024 * 1_024; // 1 MiB
/** Per-request network timeout. */
const FETCH_TIMEOUT_MS = 30_000;

// ── Config ────────────────────────────────────────────────────────────────────

/** TTL range enforced by the authority (seconds). */
const TTL_MIN = 60;
const TTL_MAX = 21_600;
const TTL_DEFAULT = 3_600;

/**
 * Validated runtime config for the work-lease authority.
 *
 * Sourced exclusively from environment variables — never from config files,
 * issue content, or user input.
 */
export interface WorkLeaseConfig {
	/** Authority endpoint URL (CYRUS_WORK_LEASE_URL). */
	url: string;
	/** Cyrus principal ID the authority expects (CYRUS_WORK_LEASE_PRINCIPAL_ID). */
	principalId: string;
	/** Requested TTL in seconds, clamped to [60, 21600] (CYRUS_WORK_LEASE_TTL_SECONDS). */
	ttlSeconds: number;
}

/**
 * Read and validate the work-lease config from environment variables.
 *
 * Returns `null` when any required variable is absent (used to gate the marker
 * path without reading the token on the legacy/no-marker path).
 */
export function readWorkLeaseConfig(): WorkLeaseConfig | null {
	const url = process.env.CYRUS_WORK_LEASE_URL;
	const principalId = process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID;

	if (!url?.trim() || !principalId?.trim()) {
		return null;
	}

	const rawTtl = process.env.CYRUS_WORK_LEASE_TTL_SECONDS;
	let ttlSeconds: number;
	if (rawTtl) {
		const parsed = Number.parseInt(rawTtl, 10);
		ttlSeconds = Number.isNaN(parsed)
			? TTL_DEFAULT
			: Math.min(TTL_MAX, Math.max(TTL_MIN, parsed));
	} else {
		ttlSeconds = TTL_DEFAULT;
	}

	return { url: url.trim(), principalId: principalId.trim(), ttlSeconds };
}

/**
 * Read the bearer token for the work-lease authority.
 *
 * Separated from `readWorkLeaseConfig` so that the token is never included in
 * config objects that might be logged or serialised.
 */
export function readWorkLeaseToken(): string | null {
	const token = process.env.CYRUS_WORK_LEASE_TOKEN;
	return token?.trim() || null;
}

// ── Lease response shape ──────────────────────────────────────────────────────

/**
 * Minimal shape of an authority lease response object.
 * The authority may return additional fields; we validate only what we need.
 */
export interface LeaseResponseBody {
	ok: boolean;
	lease_id?: string;
	owner?: string;
	adopted_from?: string;
	adopted_at?: string;
	expires_at?: string;
	canonical_repo?: string;
	scope?: string[];
	policy_hash?: string;
	lease_version?: string;
	[key: string]: unknown;
}

// ── Error class ───────────────────────────────────────────────────────────────

/** Thrown whenever the authority returns an invalid or unexpected response. */
export class WorkLeaseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkLeaseError";
	}
}

// ── Client ────────────────────────────────────────────────────────────────────

/**
 * HTTP client that adopts a bridge work lease and verifies the adoption via
 * an immediate GET readback.
 *
 * Usage:
 * ```ts
 * const client = new WorkLeaseClient(config, logger);
 * const lease = await client.adoptAndVerify(handoffData, bearerToken);
 * // lease is the verified readback — startup may now proceed
 * ```
 */
export class WorkLeaseClient {
	private readonly config: WorkLeaseConfig;
	private readonly logger: ILogger;

	constructor(config: WorkLeaseConfig, logger: ILogger) {
		this.config = config;
		this.logger = logger;
	}

	/**
	 * Adopt the lease described in `handoff` and immediately verify via GET.
	 *
	 * @param handoff      Validated handoff marker data (from HandoffMarkerParser).
	 * @param bearerToken  The Cyrus bearer token (CYRUS_WORK_LEASE_TOKEN).
	 *                     NOT logged or stored in the returned object.
	 * @returns            The verified GET readback lease object.
	 * @throws WorkLeaseError on any failure (network, HTTP error, binding mismatch).
	 */
	async adoptAndVerify(
		handoff: HandoffMarkerData,
		bearerToken: string,
	): Promise<LeaseResponseBody> {
		// ── Adopt ─────────────────────────────────────────────────────────────────
		const adoptPayload = {
			action: "adopt",
			lease_id: handoff.lease_id,
			canonical_repo: handoff.canonical_repo,
			scope: handoff.scope,
			policy_hash: handoff.policy_hash,
			lease_version: handoff.lease_version,
			ttl_seconds: this.config.ttlSeconds,
		};

		this.logger.info(
			`[WorkLease] Adopting lease ${handoff.lease_id} (issue ${handoff.issue_id})`,
		);

		const adoptResp = await this.post(adoptPayload, bearerToken);
		this.validateAdoptResponse(adoptResp, handoff);

		this.logger.info(
			`[WorkLease] Adopt accepted; performing immediate readback for lease ${handoff.lease_id}`,
		);

		// ── Immediate GET readback ────────────────────────────────────────────────
		const getPayload = { action: "get", lease_id: handoff.lease_id };
		const getResp = await this.post(getPayload, bearerToken);
		this.validateGetResponse(getResp, adoptResp, handoff);

		this.logger.info(
			`[WorkLease] Lease ${handoff.lease_id} verified — startup may proceed`,
		);

		return getResp;
	}

	// ── Private helpers ───────────────────────────────────────────────────────────

	private async post(
		body: Record<string, unknown>,
		bearerToken: string,
	): Promise<LeaseResponseBody> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		let response: Response;
		try {
			response = await fetch(this.config.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					// Token is passed in the request header only — never stored/logged
					Authorization: `Bearer ${bearerToken}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (err) {
			throw new WorkLeaseError(
				`Network error reaching work-lease authority (action='${body.action}'): ${(err as Error).message}`,
			);
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			throw new WorkLeaseError(
				`Authority returned HTTP ${response.status} for action='${body.action}'`,
			);
		}

		let text: string;
		try {
			text = await response.text();
		} catch (err) {
			throw new WorkLeaseError(
				`Failed to read authority response body: ${(err as Error).message}`,
			);
		}

		if (text.length > MAX_BODY_BYTES) {
			throw new WorkLeaseError(
				`Authority response body exceeds size limit (${text.length} bytes)`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			throw new WorkLeaseError(
				`Authority returned non-JSON response: ${(err as Error).message}`,
			);
		}

		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new WorkLeaseError("Authority response is not a JSON object");
		}

		return parsed as LeaseResponseBody;
	}

	private validateAdoptResponse(
		resp: LeaseResponseBody,
		handoff: HandoffMarkerData,
	): void {
		if (!resp.ok) {
			throw new WorkLeaseError("Adopt returned ok:false");
		}
		if (resp.lease_id !== handoff.lease_id) {
			throw new WorkLeaseError(
				`Adopt response lease_id mismatch: expected '${handoff.lease_id}', got '${resp.lease_id}'`,
			);
		}
		if (resp.owner !== this.config.principalId) {
			throw new WorkLeaseError(
				`Adopt response owner mismatch: expected principal '${this.config.principalId}', got '${resp.owner}'`,
			);
		}
		if (resp.adopted_from !== handoff.owner) {
			throw new WorkLeaseError(
				`Adopt response adopted_from mismatch: expected '${handoff.owner}', got '${resp.adopted_from}'`,
			);
		}
		if (typeof resp.adopted_at !== "string" || !resp.adopted_at.trim()) {
			throw new WorkLeaseError("Adopt response is missing a valid adopted_at");
		}
		// adopted_at must parse as a real date
		if (Number.isNaN(Date.parse(resp.adopted_at))) {
			throw new WorkLeaseError(
				`Adopt response adopted_at is not a valid timestamp: '${resp.adopted_at}'`,
			);
		}
		// Lease must not already be expired
		if (resp.expires_at !== undefined) {
			const expiresMs = Date.parse(resp.expires_at as string);
			if (!Number.isNaN(expiresMs) && expiresMs <= Date.now()) {
				throw new WorkLeaseError(
					"Adopt response indicates the lease has already expired",
				);
			}
		}
	}

	private validateGetResponse(
		resp: LeaseResponseBody,
		adoptResp: LeaseResponseBody,
		handoff: HandoffMarkerData,
	): void {
		if (!resp.ok) {
			throw new WorkLeaseError("GET readback returned ok:false");
		}
		if (resp.lease_id !== handoff.lease_id) {
			throw new WorkLeaseError(
				`GET readback lease_id mismatch: expected '${handoff.lease_id}', got '${resp.lease_id}'`,
			);
		}
		if (resp.owner !== this.config.principalId) {
			throw new WorkLeaseError(
				`GET readback owner mismatch: expected principal '${this.config.principalId}', got '${resp.owner}'`,
			);
		}
		if (resp.adopted_from !== handoff.owner) {
			throw new WorkLeaseError(
				`GET readback adopted_from mismatch: expected '${handoff.owner}', got '${resp.adopted_from}'`,
			);
		}
		if (typeof resp.adopted_at !== "string" || !resp.adopted_at.trim()) {
			throw new WorkLeaseError("GET readback is missing a valid adopted_at");
		}
		// adopted_at must agree with what adopt returned (immutable binding)
		if (resp.adopted_at !== adoptResp.adopted_at) {
			throw new WorkLeaseError(
				`GET readback adopted_at differs from adopt response: '${resp.adopted_at}' vs '${adoptResp.adopted_at}'`,
			);
		}
		if (Number.isNaN(Date.parse(resp.adopted_at))) {
			throw new WorkLeaseError(
				`GET readback adopted_at is not a valid timestamp: '${resp.adopted_at}'`,
			);
		}
		// Lease must still be active
		if (resp.expires_at !== undefined) {
			const expiresMs = Date.parse(resp.expires_at as string);
			if (!Number.isNaN(expiresMs) && expiresMs <= Date.now()) {
				throw new WorkLeaseError(
					"GET readback indicates the lease has already expired",
				);
			}
		}
	}
}

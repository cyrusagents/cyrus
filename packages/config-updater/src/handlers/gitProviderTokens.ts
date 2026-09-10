import { dirname } from "node:path";
import { GitProviderTokenStore } from "cyrus-core";
import {
	type ApiResponse,
	type GitProviderTokensPayload,
	GitProviderTokensPayloadSchema,
} from "../types.js";
import {
	ensureGitCredentialHelper,
	ensureGlabWrapperSupportsCyrusToken,
} from "./githubTokens.js";

export async function handleGitProviderTokens(
	rawPayload: unknown,
	cyrusHome: string,
): Promise<ApiResponse> {
	const parseResult = GitProviderTokensPayloadSchema.safeParse(rawPayload);
	if (!parseResult.success) {
		const firstIssue = parseResult.error.issues[0];
		const path = firstIssue?.path.join(".") || "unknown";
		const message = firstIssue?.message || "Invalid payload";
		return {
			success: false,
			error: "Git provider tokens payload validation failed",
			details: `${path}: ${message}`,
		};
	}

	const payload: GitProviderTokensPayload = parseResult.data;

	try {
		new GitProviderTokenStore(cyrusHome).save(payload.tokens);
	} catch (error) {
		return {
			success: false,
			error: "Failed to save git provider tokens",
			details: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		ensureGitCredentialHelper(cyrusHome);
	} catch (error) {
		return {
			success: false,
			error: "Failed to configure git credential helper",
			details: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		ensureGlabWrapperSupportsCyrusToken(dirname(cyrusHome));
	} catch (error) {
		console.warn(
			"[gitProviderTokens] glab wrapper self-heal failed:",
			error instanceof Error ? error.message : String(error),
		);
	}

	return {
		success: true,
		message: "Git provider tokens updated successfully",
		data: {
			tokensCount: payload.tokens.length,
			providers: Array.from(
				new Set(payload.tokens.map((t) => t.provider)),
			).sort(),
		},
	};
}

/**
 * Codex app-server → client request methods that ask a human to approve,
 * grant, or answer something. Method names and response shapes come from the
 * Codex 0.163.0 generated app-server schema (`ServerRequest.json`).
 */
const DECLINE_RESPONSES: Readonly<Record<string, unknown>> = {
	// v2 approvals: CommandExecutionApprovalDecision / FileChangeApprovalDecision
	"item/commandExecution/requestApproval": { decision: "decline" },
	"item/fileChange/requestApproval": { decision: "decline" },
	// Permission grants: an empty profile grants nothing (fileSystem/network
	// stay unset) for this turn only.
	"item/permissions/requestApproval": { permissions: {}, scope: "turn" },
	"mcpServer/elicitation/request": { action: "decline" },
	"item/tool/requestUserInput": { answers: {} },
	// Legacy v1 approvals: ReviewDecision
	execCommandApproval: { decision: "denied" },
	applyPatchApproval: { decision: "denied" },
};

/** Whether a server request asks for a human approval/grant/answer. */
export function isHumanApprovalRequest(method: string): boolean {
	return method in DECLINE_RESPONSES || /approval/i.test(method);
}

/**
 * Schema-valid denial for a human-approval server request. Used for threads in
 * `toolApprovalMode: "auto"`, where Codex's own `auto_review` reviewer must
 * make every decision: any request that still reaches the client (an older
 * Codex that ignored `approvalsReviewer`, a reviewer fallback, a permission
 * escalation) is denied rather than accepted.
 */
export function declineHumanApprovalRequest(method: string): unknown {
	return DECLINE_RESPONSES[method] ?? { decision: "decline" };
}

/**
 * Pre-existing response for threads in allowlist mode (Codex runs with
 * `approvalPolicy: "never"`, so these requests are not expected). Kept
 * byte-for-byte so default behavior does not change.
 */
export function legacyServerRequestResponse(method: string): unknown {
	if (/auth/i.test(method)) {
		return { chatgptAuthToken: null };
	}
	if (/approval/i.test(method)) {
		return { decision: "accept" };
	}
	return {};
}

/** Client-side approval policy of a pooled app-server process. */
export type ToolApprovalPolicy = "allowlist" | "auto";

/**
 * Decide the response to a server request for a process with the given
 * policy. Auto processes deny every human-approval request; allowlist
 * processes keep the legacy response unchanged.
 */
export function resolveServerRequest(
	method: string,
	policy: ToolApprovalPolicy,
): unknown {
	if (policy === "auto" && isHumanApprovalRequest(method)) {
		return declineHumanApprovalRequest(method);
	}
	return legacyServerRequestResponse(method);
}

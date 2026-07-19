import type { SDKMessage } from "cyrus-claude-runner";
import type { CyrusAgentSession, Issue, Workspace } from "cyrus-core";

/**
 * Events emitted by EdgeWorker
 */
export interface EdgeWorkerEvents {
	// Connection events (now includes token to identify which connection)
	connected: (token: string) => void;
	disconnected: (token: string, reason?: string) => void;

	// Session events (now includes repository ID)
	"session:started": (
		issueId: string,
		issue: Issue,
		repositoryId: string,
	) => void;
	"session:ended": (
		issueId: string,
		exitCode: number | null,
		repositoryId: string,
	) => void;

	// Claude messages (now includes repository ID)
	"claude:message": (
		issueId: string,
		message: SDKMessage,
		repositoryId: string,
	) => void;
	"claude:response": (
		issueId: string,
		text: string,
		repositoryId: string,
	) => void;
	"claude:tool-use": (
		issueId: string,
		tool: string,
		input: any,
		repositoryId: string,
	) => void;

	// Error events
	error: (error: Error, context?: any) => void;
}

/**
 * Data returned from createAgentSession
 */
export interface AgentSessionData {
	session: CyrusAgentSession;
	fullIssue: Issue;
	workspace: Workspace;
	attachmentResult: { manifest: string; attachmentsDir: string | null };
	attachmentsDir: string;
	allowedDirectories: string[];
	allowedTools: string[];
	disallowedTools: string[];
	/**
	 * Issue labels fetched during session creation. Returned here so callers
	 * (e.g. {@link SessionOrchestrator.startSession}) can await the in-flight
	 * fetch that was kicked off alongside workspace creation rather than issuing
	 * a second round-trip.
	 */
	labels: string[];
}

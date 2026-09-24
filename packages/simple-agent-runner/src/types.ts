/**
 * Re-export types from core to maintain backward compatibility
 *
 * These types are now defined in miko-core to avoid circular dependencies.
 * Simple-agent-runner implements the interfaces defined in core.
 */
export type {
	IAgentProgressEvent as AgentProgressEvent,
	ISimpleAgentQueryOptions as SimpleAgentQueryOptions,
	ISimpleAgentResult as SimpleAgentResult,
	ISimpleAgentRunnerConfig as SimpleAgentRunnerConfig,
} from "miko-core";

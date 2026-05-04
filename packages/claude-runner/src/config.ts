/**
 * Claude CLI configuration helpers
 *
 * Skills Documentation:
 * - Claude Code CLI: https://code.claude.com/docs/en/skills
 * - Agent SDK: https://platform.claude.com/docs/en/agent-sdk/skills
 *
 * IMPORTANT: The `allowed-tools` frontmatter field in SKILL.md is only supported
 * when using Claude Code CLI directly. It does not apply when using Skills through
 * the SDK. When using the SDK, control tool access through the main `allowedTools`
 * option in your query configuration.
 */

/**
 * List of all available tools in Claude Code
 */
export const availableTools = [
	// File system tools
	"Read(**)",
	"Edit(**)",
	"Write(**)",
	"Glob",
	"Grep",

	// Execution tools
	"Bash",
	"Task",

	// Web tools
	"WebFetch",
	"WebSearch",

	// Task management
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",

	// Notebook tools
	"NotebookEdit",

	// Skills - enables Claude to use packaged capabilities (SKILL.md files)
	// See: https://platform.claude.com/docs/en/agent-sdk/skills
	"Skill",

	// User interaction tools
	"AskUserQuestion",
	"SendMessage",
	"PushNotification",

	// Plan and worktree management
	"EnterPlanMode",
	"ExitPlanMode",
	"EnterWorktree",
	"ExitWorktree",

	// Scheduling and cron tools
	"CronCreate",
	"CronDelete",
	"CronList",
	"RemoteTrigger",
	"ScheduleWakeup",

	// Monitoring and task lifecycle
	"Monitor",
	"TaskOutput",
	"TaskStop",

	// Team management
	"TeamCreate",
	"TeamDelete",

	// Tool discovery
	"ToolSearch",
] as const;

export type ToolName = (typeof availableTools)[number];

/**
 * Default read-only tools that are safe to enable
 * Note: Task tools are included as they only modify task tracking, not actual code files
 * Note: Skill is included as it enables Claude to use Skills which are packaged capabilities
 */
export const readOnlyTools: ToolName[] = [
	"Read(**)",
	"Glob",
	"Grep",
	"WebFetch",
	"WebSearch",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"Task",
	"Skill",
	"Monitor",
	"TaskOutput",
	"EnterPlanMode",
	"ExitPlanMode",
	"ToolSearch",
];

/**
 * Tools that can modify the file system or state
 */
export const writeTools: ToolName[] = [
	"Edit(**)",
	"Write(**)",
	"Bash",
	"NotebookEdit",
];

/**
 * Get a safe set of tools for read-only operations
 */
export function getReadOnlyTools(): string[] {
	return [...readOnlyTools];
}

/**
 * Get all available tools
 */
export function getAllTools(): string[] {
	return [...availableTools];
}

/**
 * Get all tools except Bash (safer default for repository configuration)
 */
export function getSafeTools(): string[] {
	return [...availableTools].filter((t) => t !== "Bash");
}

/**
 * Get coordinator tools - all tools except those that can edit files
 * Excludes: Edit, Write, NotebookEdit (no file/content modification)
 * Used by orchestrator role for coordination without direct file modification
 */
export function getCoordinatorTools(): string[] {
	return [...availableTools].filter(
		(t) => t !== "Edit(**)" && t !== "Write(**)" && t !== "NotebookEdit",
	);
}

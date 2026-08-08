import type { SDKRateLimitEvent } from "cyrus-claude-runner";
import type {
	AgentRunnerConfig,
	EdgeWorkerConfig,
	IAgentRunner,
	RunnerType,
} from "cyrus-core";
import type { AgentSessionManager } from "./AgentSessionManager.js";

export interface RunnerFallbackTurn {
	sessionId: string;
	runnerType: RunnerType;
	selectionWasExplicit: boolean;
	prompt: string;
	buildConfig: (runnerType: RunnerType) => Promise<AgentRunnerConfig>;
}

interface RunnerFallbackContext extends RunnerFallbackTurn {
	attemptedRunners: Set<RunnerType>;
}

export interface RunnerFallbackControllerDependencies {
	getConfig: () => EdgeWorkerConfig;
	sessionManager: AgentSessionManager;
	createRunner: (
		runnerType: RunnerType,
		config: AgentRunnerConfig,
	) => IAgentRunner;
}

/** Coordinates a bounded provider transition without replacing Cyrus state. */
export class RunnerFallbackController {
	private readonly contexts = new Map<string, RunnerFallbackContext>();

	constructor(
		private readonly dependencies: RunnerFallbackControllerDependencies,
	) {}

	registerTurn(turn: RunnerFallbackTurn): void {
		this.contexts.set(turn.sessionId, {
			...turn,
			attemptedRunners: new Set([turn.runnerType]),
		});
	}

	removeSession(sessionId: string): void {
		this.contexts.delete(sessionId);
	}

	async handleRateLimit(
		sessionId: string,
		message: SDKRateLimitEvent,
	): Promise<boolean> {
		const context = this.contexts.get(sessionId);
		const info = message.rate_limit_info;
		if (!context || info.status !== "rejected" || !info.rateLimitType) {
			return false;
		}

		const policy =
			this.dependencies.getConfig().runnerFallbacks?.[context.runnerType];
		if (!policy?.rateLimitTypes.includes(info.rateLimitType)) {
			return false;
		}
		if (context.selectionWasExplicit && !policy.overrideExplicitSelectors) {
			return false;
		}

		// Drop the failed provider's trailing assistant/result messages immediately.
		// Otherwise they can race the replacement runner and post a false success.
		this.dependencies.sessionManager.suppressRunnerSession(
			sessionId,
			message.session_id,
		);

		for (const fallbackType of policy.runners) {
			if (context.attemptedRunners.has(fallbackType)) continue;
			context.attemptedRunners.add(fallbackType);

			let runner: IAgentRunner;
			try {
				const config = await context.buildConfig(fallbackType);
				runner = this.dependencies.createRunner(fallbackType, config);
				if (runner.isAvailable && !(await runner.isAvailable())) {
					continue;
				}
			} catch {
				continue;
			}

			await this.dependencies.sessionManager.createThoughtActivity(
				sessionId,
				this.formatTransition(context.runnerType, fallbackType, message),
			);
			this.dependencies.sessionManager.switchAgentRunner(
				sessionId,
				runner,
				fallbackType,
			);
			context.runnerType = fallbackType;

			try {
				if (runner.supportsStreamingInput && runner.startStreaming) {
					await runner.startStreaming(context.prompt);
				} else {
					await runner.start(context.prompt);
				}
			} catch (error) {
				runner.stop();
				await this.dependencies.sessionManager.failRunnerFallback(
					sessionId,
					`${this.formatQuota(message)} The ${this.displayName(fallbackType)} fallback failed to start: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return true;
		}

		this.dependencies.sessionManager.getAgentRunner(sessionId)?.stop();
		await this.dependencies.sessionManager.failRunnerFallback(
			sessionId,
			`${this.formatQuota(message)} The configured fallback runner is unavailable or unauthenticated, so execution could not continue.`,
		);
		return true;
	}

	private formatTransition(
		source: RunnerType,
		target: RunnerType,
		message: SDKRateLimitEvent,
	): string {
		return `${this.displayName(source)} quota exhausted (${message.rate_limit_info.rateLimitType}); continuing with ${this.displayName(target)}.${this.formatReset(message)}`;
	}

	private formatQuota(message: SDKRateLimitEvent): string {
		return `Claude quota exhausted (${message.rate_limit_info.rateLimitType ?? "unknown"}).${this.formatReset(message)}`;
	}

	private formatReset(message: SDKRateLimitEvent): string {
		const resetsAt = message.rate_limit_info.resetsAt;
		return resetsAt
			? ` Quota resets at ${new Date(resetsAt * 1000).toISOString()}.`
			: "";
	}

	private displayName(runnerType: RunnerType): string {
		return runnerType === "codex"
			? "Codex"
			: runnerType === "claude"
				? "Claude"
				: runnerType === "gemini"
					? "Gemini"
					: "Cursor";
	}
}

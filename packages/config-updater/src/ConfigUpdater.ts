import type { FastifyInstance } from "fastify";
import { handleCheckGh } from "./handlers/checkGh.js";
import { handleCheckGlab } from "./handlers/checkGlab.js";
import { handleConfigureMcp } from "./handlers/configureMcp.js";
import { handleGitHubTokens } from "./handlers/githubTokens.js";
import { handleMikoConfig } from "./handlers/mikoConfig.js";
import { handleMikoEnv } from "./handlers/mikoEnv.js";
import {
	handleRepository,
	handleRepositoryDelete,
} from "./handlers/repository.js";
import {
	handleDeleteSkill,
	handleListSkills,
	handleUpdateSkill,
} from "./handlers/skills.js";
import { handleTestMcp } from "./handlers/testMcp.js";
import type {
	ApiResponse,
	CheckGhPayload,
	CheckGlabPayload,
	ConfigureMcpPayload,
	DeleteRepositoryPayload,
	DeleteSkillPayload,
	GitHubTokensPayload,
	ListSkillsPayload,
	MikoConfigPayload,
	MikoEnvPayload,
	RepositoryPayload,
	TestMcpPayload,
	UpdateSkillPayload,
} from "./types.js";

/**
 * ConfigUpdater registers configuration update routes with a Fastify server
 * Handles: miko-config, miko-env, repository, update/test-mcp, update/configure-mcp, check-gh endpoints
 *
 * `getApiKey` is invoked on every auth check, so callers reading from
 * `process.env.MIKO_API_KEY` pick up `.env` reloads (triggered by
 * `miko auth` after a credential rotation) without restarting the process.
 */
export class ConfigUpdater {
	private fastify: FastifyInstance;
	private mikoHome: string;
	private getApiKey: () => string;

	constructor(
		fastify: FastifyInstance,
		mikoHome: string,
		getApiKey: () => string,
	) {
		this.fastify = fastify;
		this.mikoHome = mikoHome;
		this.getApiKey = getApiKey;
	}

	/**
	 * Register all configuration update routes with the Fastify instance
	 */
	register(): void {
		// Register all routes with authentication
		this.registerRoute("/api/update/miko-config", this.handleMikoConfigRoute);
		this.registerRoute("/api/update/miko-env", this.handleMikoEnvRoute);
		this.registerRoute("/api/update/repository", this.handleRepositoryRoute);
		this.registerDeleteRoute(
			"/api/update/repository",
			this.handleRepositoryDeleteRoute,
		);
		this.registerRoute("/api/update/test-mcp", this.handleTestMcpRoute);
		this.registerRoute(
			"/api/update/configure-mcp",
			this.handleConfigureMcpRoute,
		);
		this.registerRoute(
			"/api/update/github-tokens",
			this.handleGitHubTokensRoute,
		);
		this.registerRoute("/api/check-gh", this.handleCheckGhRoute);
		this.registerRoute("/api/check-glab", this.handleCheckGlabRoute);
		this.registerRoute("/api/update/skill", this.handleUpdateSkillRoute);
		this.registerDeleteRoute("/api/update/skill", this.handleDeleteSkillRoute);
		this.registerGetRoute("/api/skills", this.handleListSkillsRoute);
	}

	/**
	 * Register a route with authentication
	 */
	private registerRoute(
		path: string,
		handler: (payload: any) => Promise<ApiResponse>,
	): void {
		this.fastify.post(path, async (request, reply) => {
			// Verify authentication
			const authHeader = request.headers.authorization;
			if (!this.verifyAuth(authHeader)) {
				return reply.status(401).send({
					success: false,
					error: "Unauthorized",
				});
			}

			try {
				const response = await handler.call(this, request.body);
				const statusCode = response.success ? 200 : 400;
				return reply.status(statusCode).send(response);
			} catch (error) {
				return reply.status(500).send({
					success: false,
					error: "Internal server error",
					details: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	/**
	 * Register a DELETE route with authentication
	 */
	private registerDeleteRoute(
		path: string,
		handler: (payload: any) => Promise<ApiResponse>,
	): void {
		this.fastify.delete(path, async (request, reply) => {
			// Verify authentication
			const authHeader = request.headers.authorization;
			if (!this.verifyAuth(authHeader)) {
				return reply.status(401).send({
					success: false,
					error: "Unauthorized",
				});
			}

			try {
				const response = await handler.call(this, request.body);
				const statusCode = response.success ? 200 : 400;
				return reply.status(statusCode).send(response);
			} catch (error) {
				return reply.status(500).send({
					success: false,
					error: "Internal server error",
					details: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	/**
	 * Register a GET route with authentication
	 */
	private registerGetRoute(
		path: string,
		handler: (payload: any) => Promise<ApiResponse>,
	): void {
		this.fastify.get(path, async (request, reply) => {
			// Verify authentication
			const authHeader = request.headers.authorization;
			if (!this.verifyAuth(authHeader)) {
				return reply.status(401).send({
					success: false,
					error: "Unauthorized",
				});
			}

			try {
				const response = await handler.call(this, request.query || {});
				const statusCode = response.success ? 200 : 400;
				return reply.status(statusCode).send(response);
			} catch (error) {
				return reply.status(500).send({
					success: false,
					error: "Internal server error",
					details: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	/**
	 * Verify Bearer token authentication
	 */
	private verifyAuth(authHeader: string | undefined): boolean {
		const apiKey = this.getApiKey();
		if (!authHeader || !apiKey) {
			return false;
		}

		const expectedAuth = `Bearer ${apiKey}`;
		return authHeader === expectedAuth;
	}

	/**
	 * Handle miko-config update
	 */
	private async handleMikoConfigRoute(
		payload: MikoConfigPayload,
	): Promise<ApiResponse> {
		const response = await handleMikoConfig(payload, this.mikoHome);

		// Emit restart event if requested
		if (response.success && response.data?.restartMiko) {
			this.fastify.log.info("Config update requested Miko restart");
		}

		return response;
	}

	/**
	 * Handle miko-env update
	 */
	private async handleMikoEnvRoute(
		payload: MikoEnvPayload,
	): Promise<ApiResponse> {
		const response = await handleMikoEnv(payload, this.mikoHome);

		// Emit restart event if requested
		if (response.success && response.data?.restartMiko) {
			this.fastify.log.info("Env update requested Miko restart");
		}

		return response;
	}

	/**
	 * Handle repository clone/verify
	 */
	private async handleRepositoryRoute(
		payload: RepositoryPayload,
	): Promise<ApiResponse> {
		return handleRepository(payload, this.mikoHome);
	}

	/**
	 * Handle MCP connection test
	 */
	private async handleTestMcpRoute(
		payload: TestMcpPayload,
	): Promise<ApiResponse> {
		return handleTestMcp(payload);
	}

	/**
	 * Handle MCP server configuration
	 */
	private async handleConfigureMcpRoute(
		payload: ConfigureMcpPayload,
	): Promise<ApiResponse> {
		return handleConfigureMcp(payload, this.mikoHome);
	}

	/**
	 * Handle GitHub installation tokens push
	 */
	private async handleGitHubTokensRoute(
		payload: GitHubTokensPayload,
	): Promise<ApiResponse> {
		return handleGitHubTokens(payload, this.mikoHome);
	}

	/**
	 * Handle GitHub CLI check
	 */
	private async handleCheckGhRoute(
		payload: CheckGhPayload,
	): Promise<ApiResponse> {
		return handleCheckGh(payload, this.mikoHome);
	}

	/**
	 * Handle GitLab CLI check
	 */
	private async handleCheckGlabRoute(
		payload: CheckGlabPayload,
	): Promise<ApiResponse> {
		return handleCheckGlab(payload, this.mikoHome);
	}

	/**
	 * Handle repository deletion
	 */
	private async handleRepositoryDeleteRoute(
		payload: DeleteRepositoryPayload,
	): Promise<ApiResponse> {
		return handleRepositoryDelete(payload, this.mikoHome);
	}

	/**
	 * Handle creating or updating a user skill
	 */
	private async handleUpdateSkillRoute(
		payload: UpdateSkillPayload,
	): Promise<ApiResponse> {
		return handleUpdateSkill(payload, this.mikoHome);
	}

	/**
	 * Handle deleting a user skill
	 */
	private async handleDeleteSkillRoute(
		payload: DeleteSkillPayload,
	): Promise<ApiResponse> {
		return handleDeleteSkill(payload, this.mikoHome);
	}

	/**
	 * Handle listing user skills
	 */
	private async handleListSkillsRoute(
		payload: ListSkillsPayload,
	): Promise<ApiResponse> {
		return handleListSkills(payload, this.mikoHome);
	}
}

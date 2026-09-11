/**
 * Per-Linear-user credential provisioning (multi-user self-host, CYPACK-1502).
 *
 *   cyrus add-user     — map a Linear user to their Claude credential + GitHub token
 *   cyrus list-users   — show the mapping (references + fingerprints, never secrets)
 *   cyrus check-users  — verify every reference resolves (optionally live provider checks)
 *   cyrus remove-user  — drop a mapping and its stored secrets
 *
 * Secrets are taken from a masked prompt, a protected file or an env var name —
 * never from a literal command-line argument (shell history) — and are stored
 * as owner-only files under ~/.cyrus/user-credentials/<linearUserId>/.
 * config.json receives references only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRunner } from "cyrus-claude-runner";
import {
	ALTERNATIVE_AUTH_ENV_KEYS,
	credentialFingerprint,
	type EdgeConfig,
	type LinearUserConfig,
	readCredentialRef,
} from "cyrus-core";
import {
	CLAUDE_API_KEY_FILE,
	CLAUDE_OAUTH_TOKEN_FILE,
	type ClaudeCredentialKind,
	detectClaudeCredentialKind,
	GITHUB_TOKEN_FILE,
	type GitHubActor,
	UserCredentialService,
} from "../services/UserCredentialService.js";
import { CLIPrompts } from "../ui/CLIPrompts.js";
import { BaseCommand } from "./ICommand.js";

export interface AddUserOptions {
	linearUserId?: string;
	linearEmail?: string;
	name?: string;
	gitName?: string;
	gitEmail?: string;
	claudeTokenFile?: string;
	claudeTokenEnv?: string;
	claudeKind?: "oauth" | "api-key";
	githubTokenFile?: string;
	githubTokenEnv?: string;
	skipClaudeCheck?: boolean;
	skipGithubCheck?: boolean;
	force?: boolean;
	workspace?: string;
}

/**
 * Resolve the Linear workspace token used for user lookups: the only
 * workspace when there is one, else the one matching `--workspace`.
 */
function pickLinearToken(
	config: EdgeConfig,
	workspace: string | undefined,
): { token: string; name: string } | undefined {
	const entries = Object.entries(config.linearWorkspaces ?? {});
	if (entries.length === 0) return undefined;
	const match = workspace
		? entries.find(
				([id, ws]) =>
					id === workspace ||
					ws.linearWorkspaceSlug === workspace ||
					ws.linearWorkspaceName === workspace,
			)
		: entries.length === 1
			? entries[0]
			: undefined;
	if (!match) return undefined;
	return {
		token: match[1].linearToken,
		name: match[1].linearWorkspaceName ?? match[0],
	};
}

/**
 * Real provider check: run a one-turn Claude session with ONLY the user's
 * credential in the child environment. Succeeds when the SDK returns a
 * `result` message with `subtype: "success"`. Returns a secret-free error
 * otherwise.
 */
export async function verifyClaudeCredentialLive(
	cyrusHome: string,
	kind: ClaudeCredentialKind,
	secret: string,
): Promise<{ ok: true; model?: string } | { ok: false; error: string }> {
	const workDir = mkdtempSync(join(tmpdir(), "cyrus-claude-check-"));
	try {
		const env: Record<string, string> =
			kind === "oauthToken"
				? { CLAUDE_CODE_OAUTH_TOKEN: secret }
				: { ANTHROPIC_API_KEY: secret };
		const omitEnv =
			kind === "oauthToken"
				? ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]
				: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];
		const runner = new ClaudeRunner({
			cyrusHome,
			workingDirectory: workDir,
			model: "haiku",
			maxTurns: 1,
			tools: [],
			allowedTools: [],
			strictMcpConfig: true,
			additionalEnv: env,
			omitEnv: [...omitEnv, ...ALTERNATIVE_AUTH_ENV_KEYS],
		});
		await runner.start("Reply with the single word OK.");
		const result = runner
			.getMessages()
			.find(
				(m): m is Extract<typeof m, { type: "result" }> => m.type === "result",
			);
		if (!result) {
			return { ok: false, error: "Claude returned no result message" };
		}
		if (result.subtype === "success") {
			const modelUsage = (result as { modelUsage?: Record<string, unknown> })
				.modelUsage;
			return {
				ok: true,
				model: modelUsage ? Object.keys(modelUsage)[0] : undefined,
			};
		}
		const errors = (result as { errors?: string[] }).errors ?? [];
		return {
			ok: false,
			error: `${result.subtype}${errors.length ? `: ${errors.join("; ")}` : ""}`,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

/**
 * Obtain a secret from one of the accepted sources (file, env var name,
 * masked prompt). Never from argv.
 */
async function obtainSecret(
	label: string,
	source: { file?: string; env?: string },
): Promise<{ secret: string; ref?: { env: string } }> {
	if (source.file && source.env) {
		throw new Error(
			`Provide either --${label}-token-file or --${label}-token-env, not both`,
		);
	}
	if (source.file) {
		return { secret: UserCredentialService.readSecretFromFile(source.file) };
	}
	if (source.env) {
		const read = readCredentialRef({ env: source.env });
		if ("error" in read) {
			throw new Error(
				`${read.error} — set it in ~/.cyrus/.env (or the environment) before running add-user`,
			);
		}
		return { secret: read.value, ref: { env: source.env } };
	}
	const typed = await CLIPrompts.askSecret(
		`Paste the ${label} token (input hidden): `,
	);
	if (!typed) throw new Error(`No ${label} token provided`);
	return { secret: typed };
}

export class AddUserCommand extends BaseCommand {
	private service = new UserCredentialService(this.app.cyrusHome);

	async execute(_args: string[], options: AddUserOptions = {}): Promise<void> {
		if (!this.app.config.exists()) {
			this.exitWithError(
				"No edge configuration found. Run `cyrus auth` or `cyrus self-auth-linear` first.",
			);
		}
		const config = this.app.config.load();

		console.log("\n👤 Adding a Linear user to per-prompter credentials");
		this.logDivider();

		// ---- 1. Resolve the Linear user -------------------------------------
		let linearUserId = options.linearUserId?.trim();
		let displayName = options.name?.trim();
		let linearEmail = options.linearEmail?.trim();
		if (!linearUserId && !linearEmail) {
			linearEmail = await CLIPrompts.ask("Linear email of the engineer: ");
		}
		const linearWs = pickLinearToken(config, options.workspace);
		if (linearWs) {
			try {
				const user = await UserCredentialService.lookupLinearUser(
					linearWs.token,
					{
						id: linearUserId,
						email: linearUserId ? undefined : linearEmail,
					},
				);
				linearUserId = user.id;
				linearEmail = user.email;
				displayName = displayName || user.displayName || user.name;
				if (!user.active) {
					console.log("⚠️  Linear reports this user as inactive.");
				}
				this.logSuccess(
					`Linear user resolved: ${displayName} <${user.email}> (${user.id}) in ${linearWs.name}`,
				);
			} catch (error) {
				if (!linearUserId) {
					this.exitWithError(
						`Could not resolve the Linear user: ${(error as Error).message}`,
					);
				}
				console.log(
					`⚠️  Linear lookup failed (${(error as Error).message}); continuing with the ID you provided.`,
				);
			}
		} else if (!linearUserId) {
			this.exitWithError(
				"No Linear workspace token available to look up an email. Pass --linear-user-id (and --name) instead, or --workspace to pick one of several workspaces.",
			);
		}
		if (!linearUserId) {
			this.exitWithError("A Linear user ID is required.");
		}
		displayName = displayName || linearEmail || linearUserId;

		if (config.linearUsers?.[linearUserId] && !options.force) {
			this.exitWithError(
				`${displayName} (${linearUserId}) is already mapped. Re-run with --force to replace the credentials.`,
			);
		}

		// ---- 2. Claude credential -------------------------------------------
		const claude = await obtainSecret("claude", {
			file: options.claudeTokenFile,
			env: options.claudeTokenEnv,
		});
		let claudeKind: ClaudeCredentialKind | undefined =
			options.claudeKind === "oauth"
				? "oauthToken"
				: options.claudeKind === "api-key"
					? "apiKey"
					: detectClaudeCredentialKind(claude.secret);
		if (!claudeKind) {
			const choice = await CLIPrompts.menu(
				"Could not detect the Claude credential type from its prefix. Which is it?",
				[
					"Claude Code OAuth token (from `claude setup-token`)",
					"Anthropic console API key",
				],
			);
			claudeKind = choice === 1 ? "apiKey" : "oauthToken";
		}
		console.log(
			`   Claude credential: ${claudeKind === "oauthToken" ? "OAuth token (claude setup-token)" : "API key"} · fingerprint ${credentialFingerprint(claude.secret)}`,
		);
		if (!options.skipClaudeCheck) {
			console.log(
				"   Verifying the Claude credential with a one-turn haiku round trip…",
			);
			const check = await verifyClaudeCredentialLive(
				this.app.cyrusHome,
				claudeKind,
				claude.secret,
			);
			if (!check.ok) {
				this.exitWithError(
					`Claude credential check failed: ${check.error}. Re-run with --skip-claude-check to store it anyway.`,
				);
			}
			this.logSuccess(
				`Claude credential works${check.model ? ` (model ${check.model})` : ""}`,
			);
		}

		// ---- 3. GitHub token --------------------------------------------------
		const github = await obtainSecret("github", {
			file: options.githubTokenFile,
			env: options.githubTokenEnv,
		});
		let actor: GitHubActor | undefined;
		if (!options.skipGithubCheck) {
			try {
				actor = await UserCredentialService.verifyGitHubToken(github.secret);
			} catch (error) {
				this.exitWithError(
					`${(error as Error).message} Re-run with --skip-github-check to store it anyway.`,
				);
			}
			this.logSuccess(
				`GitHub token verified: acts as @${actor.login}${actor.name ? ` (${actor.name})` : ""} · fingerprint ${credentialFingerprint(github.secret)}${actor.tokenScopes ? ` · scopes: ${actor.tokenScopes}` : " · fine-grained token"}`,
			);
		}
		const gitAuthorName = options.gitName?.trim() || actor?.name || displayName;
		const gitAuthorEmail =
			options.gitEmail?.trim() || actor?.email || actor?.noreplyEmail;

		// ---- 4. Store secrets (files) and references (config) ---------------
		const claudeRef =
			claude.ref ??
			this.service.storeSecretFile(
				linearUserId,
				claudeKind === "oauthToken"
					? CLAUDE_OAUTH_TOKEN_FILE
					: CLAUDE_API_KEY_FILE,
				claude.secret,
			);
		const githubRef =
			github.ref ??
			this.service.storeSecretFile(
				linearUserId,
				GITHUB_TOKEN_FILE,
				github.secret,
			);

		const entry: LinearUserConfig = {
			displayName,
			...(linearEmail ? { email: linearEmail } : {}),
			claude:
				claudeKind === "oauthToken"
					? { oauthToken: claudeRef }
					: { apiKey: claudeRef },
			github: {
				token: githubRef,
				...(actor ? { login: actor.login } : {}),
				gitAuthorName,
				...(gitAuthorEmail ? { gitAuthorEmail } : {}),
			},
		};
		this.app.config.save(
			UserCredentialService.upsertUser(config, linearUserId, entry),
		);

		this.logDivider();
		this.logSuccess(`Mapped ${displayName} (${linearUserId})`);
		console.log(
			`   Claude:  ${"env" in claudeRef ? `env ${claudeRef.env}` : claudeRef.file}`,
		);
		console.log(
			`   GitHub:  ${"env" in githubRef ? `env ${githubRef.env}` : githubRef.file}${actor ? ` (@${actor.login})` : ""}`,
		);
		console.log(
			`   Git:     ${gitAuthorName} <${gitAuthorEmail ?? "(host default)"}>`,
		);
		console.log(
			"\nSessions this user triggers in Linear now run with these credentials. A running `cyrus` picks the change up automatically.",
		);
	}
}

export class ListUsersCommand extends BaseCommand {
	async execute(): Promise<void> {
		const config = this.app.config.exists()
			? this.app.config.load()
			: undefined;
		const users = config?.linearUsers ?? {};
		const ids = Object.keys(users);
		if (ids.length === 0) {
			console.log("No Linear users mapped. Run `cyrus add-user` to add one.");
			return;
		}
		console.log(`\n${ids.length} mapped Linear user(s):\n`);
		for (const id of ids) {
			const info = UserCredentialService.inspectUser(id, users[id]!);
			console.log(`• ${info.displayName}  (${id})`);
			console.log(
				`    Claude:  ${info.claude.kind}  ${info.claude.ref}  ${info.claude.ok ? `✅ #${info.claude.fingerprint}` : `❌ ${info.claude.error}`}`,
			);
			console.log(
				`    GitHub:  ${info.github.login ? `@${info.github.login}  ` : ""}${info.github.ref}  ${info.github.ok ? `✅ #${info.github.fingerprint}` : `❌ ${info.github.error}`}`,
			);
			const gh = users[id]?.github;
			if (gh?.gitAuthorName || gh?.gitAuthorEmail) {
				console.log(
					`    Git:     ${gh.gitAuthorName ?? ""} <${gh.gitAuthorEmail ?? ""}>`,
				);
			}
		}
		const policy = config?.prompterCredentialPolicy ?? {};
		console.log(
			`\nPolicy: unmappedPrompter=${policy.unmappedPrompter ?? "reject"} nonHumanTrigger=${policy.nonHumanTrigger ?? "reject"} externalPlatformSessions=${policy.externalPlatformSessions ?? "shared"} followUpByOtherUser=${policy.followUpByOtherUser ?? "pin"}`,
		);
	}
}

export class CheckUsersCommand extends BaseCommand {
	async execute(
		_args: string[],
		options: { live?: boolean } = {},
	): Promise<void> {
		const config = this.app.config.exists()
			? this.app.config.load()
			: undefined;
		const users = config?.linearUsers ?? {};
		const ids = Object.keys(users);
		if (ids.length === 0) {
			console.log("No Linear users mapped.");
			return;
		}
		let failures = 0;
		for (const id of ids) {
			const entry = users[id]!;
			const info = UserCredentialService.inspectUser(id, entry);
			console.log(`\n${info.displayName} (${id})`);
			console.log(
				`  Claude ${info.claude.ok ? `✅ resolves (#${info.claude.fingerprint})` : `❌ ${info.claude.error}`}`,
			);
			console.log(
				`  GitHub ${info.github.ok ? `✅ resolves (#${info.github.fingerprint})` : `❌ ${info.github.error}`}`,
			);
			if (!info.claude.ok || !info.github.ok) failures++;
			if (!options.live) continue;

			// Live provider checks — real proof, not just "the reference resolves".
			if (info.github.ok && entry.github?.token) {
				const secret = UserCredentialService.readSecret(entry.github.token);
				try {
					const actor = await UserCredentialService.verifyGitHubToken(
						secret ?? "",
					);
					const drift =
						entry.github.login && entry.github.login !== actor.login;
					console.log(
						`  GitHub API ✅ token acts as @${actor.login}${drift ? ` ⚠️ config says @${entry.github.login}` : ""}`,
					);
					if (drift) failures++;
				} catch (error) {
					console.log(`  GitHub API ❌ ${(error as Error).message}`);
					failures++;
				}
			}
			if (info.claude.ok) {
				const claudeKind = info.claude.kind;
				const ref = entry.claude?.oauthToken ?? entry.claude?.apiKey;
				const secret = ref ? UserCredentialService.readSecret(ref) : undefined;
				if (secret) {
					const check = await verifyClaudeCredentialLive(
						this.app.cyrusHome,
						claudeKind,
						secret,
					);
					console.log(
						check.ok
							? `  Claude API ✅ one-turn round trip succeeded${check.model ? ` (${check.model})` : ""}`
							: `  Claude API ❌ ${check.error}`,
					);
					if (!check.ok) failures++;
				}
			}
		}
		console.log();
		if (failures > 0) {
			this.exitWithError(
				`${failures} problem(s) found. Fix with \`cyrus add-user --force\`.`,
			);
		}
		this.logSuccess("All mapped users resolve.");
	}
}

export class RemoveUserCommand extends BaseCommand {
	private service = new UserCredentialService(this.app.cyrusHome);

	async execute(args: string[]): Promise<void> {
		const target = args[0]?.trim();
		if (!target) {
			this.exitWithError("Usage: cyrus remove-user <linear-user-id | email>");
		}
		if (!this.app.config.exists()) {
			this.exitWithError("No edge configuration found.");
		}
		const config = this.app.config.load();
		const users = config.linearUsers ?? {};
		const id =
			target in users
				? target
				: Object.keys(users).find(
						(key) => users[key]?.email?.toLowerCase() === target.toLowerCase(),
					);
		if (!id) {
			this.exitWithError(
				`No mapped user matches "${target}". See \`cyrus list-users\`.`,
			);
		}
		const entry = users[id]!;
		const { config: next } = UserCredentialService.removeUser(config, id);
		this.app.config.save(next);
		const removedFiles = this.service.removeStoredSecrets(id);
		this.logSuccess(
			`Removed ${entry.displayName ?? id} (${id})${removedFiles ? " and deleted the stored secret files" : ""}.`,
		);
		const envRefs = [
			entry.claude?.oauthToken,
			entry.claude?.apiKey,
			entry.github?.token,
		]
			.filter((ref): ref is { env: string } => !!ref && "env" in ref)
			.map((ref) => ref.env);
		if (envRefs.length > 0) {
			console.log(
				`Note: the environment variable(s) ${envRefs.join(", ")} still hold the secret(s); remove them from ~/.cyrus/.env yourself.`,
			);
		}
	}
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSessionCreatedWebhook,
	AgentSessionPromptedWebhook,
	CyrusAgentSession,
	ILogger,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	PrompterCredentialError,
	PrompterCredentialService,
} from "../src/PrompterCredentialService.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

const ADA = "lin-ada";
const BOB = "lin-bob";
const APP_USER = "cyrus-app-user";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cyrus-pcs-"));
	process.env.PCS_TEST_ADA_CLAUDE = "sk-ant-oat01-ada-placeholder";
	process.env.PCS_TEST_ADA_GH = "github_pat_ada_placeholder";
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	delete process.env.PCS_TEST_ADA_CLAUDE;
	delete process.env.PCS_TEST_ADA_GH;
});

function service(overrides: Partial<{ policy: Record<string, string> }> = {}) {
	return new PrompterCredentialService(
		{
			linearUsers: {
				[ADA]: {
					displayName: "Ada",
					claude: { oauthToken: { env: "PCS_TEST_ADA_CLAUDE" } },
					github: { token: { env: "PCS_TEST_ADA_GH" }, login: "ada" },
				},
				[BOB]: { displayName: "Bob" }, // mapped but incomplete
			},
			prompterCredentialPolicy: overrides.policy as never,
		},
		home,
		silentLogger,
	);
}

function createdWebhook(
	creatorId: string | undefined,
): AgentSessionCreatedWebhook {
	return {
		appUserId: APP_USER,
		organizationId: "org",
		agentSession: {
			id: "sess-1",
			appUserId: APP_USER,
			...(creatorId
				? {
						creatorId,
						creator: {
							id: creatorId,
							name: `User ${creatorId}`,
							email: `${creatorId}@x.io`,
						},
					}
				: {}),
		},
	} as unknown as AgentSessionCreatedWebhook;
}

function promptedWebhook(
	creatorId: string,
	activityUserId?: string,
): AgentSessionPromptedWebhook {
	return {
		...createdWebhook(creatorId),
		agentActivity: {
			id: "act-1",
			userId: activityUserId,
			content: { type: "prompt", body: "go" },
		},
	} as unknown as AgentSessionPromptedWebhook;
}

function session(prompter?: CyrusAgentSession["prompter"]): CyrusAgentSession {
	return { id: "sess-1", prompter } as unknown as CyrusAgentSession;
}

describe("PrompterCredentialService", () => {
	it("is disabled without mapped users for NEW sessions, but an existing pin still fails closed", () => {
		const svc = new PrompterCredentialService({}, home, silentLogger);
		expect(svc.isEnabled()).toBe(false);
		expect(
			svc.decideForNewSession({ prompter: undefined, isNonHuman: true }),
		).toBeNull();
		expect(svc.resolveForSession(session(undefined))).toBeUndefined();
		expect(
			svc.decideForFollowUp({
				session: session(undefined),
				prompter: { linearUserId: BOB },
			}),
		).toBeNull();
		// A session pinned to a user whose mapping is gone must refuse, not
		// silently run with host credentials.
		const pinned = session({
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter",
		});
		expect(() => svc.resolveForSession(pinned)).toThrow(
			PrompterCredentialError,
		);
		expect(svc.validatePin(pinned.prompter as never)).toContain(
			"no entry in linearUsers",
		);
		expect(
			svc.decideForFollowUp({
				session: pinned,
				prompter: { linearUserId: BOB },
			}),
		).not.toBeNull();
	});

	it("removing the last mapped user (config reload) turns that user's sessions into refusals", () => {
		const svc = service();
		const pin = {
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter" as const,
		};
		expect(svc.resolveForSession(session(pin))?.env.GH_TOKEN).toBe(
			"github_pat_ada_placeholder",
		);
		svc.updateConfig({ linearUsers: {} }); // last user removed
		expect(svc.isEnabled()).toBe(false);
		expect(() => svc.resolveForSession(session(pin))).toThrow(
			/no entry in linearUsers/,
		);
	});

	it("does not fall back to the session creator when a prompt carries no author", () => {
		expect(
			PrompterCredentialService.prompterFromPromptedWebhook(
				promptedWebhook(ADA, undefined),
				null,
			),
		).toBeUndefined();
		expect(
			PrompterCredentialService.prompterFromPromptedWebhook(
				promptedWebhook(ADA, undefined),
				{ id: BOB, name: "Bob" },
			),
		).toEqual({ linearUserId: BOB, name: "Bob", email: undefined });
	});

	it("extracts the prompter from created and prompted webhooks", () => {
		expect(
			PrompterCredentialService.prompterFromCreatedWebhook(createdWebhook(ADA)),
		).toEqual({
			linearUserId: ADA,
			name: `User ${ADA}`,
			email: `${ADA}@x.io`,
		});
		expect(
			PrompterCredentialService.prompterFromCreatedWebhook(
				createdWebhook(undefined),
			),
		).toBeUndefined();
		// Follow-up by a different human: the activity's userId wins over the session creator.
		expect(
			PrompterCredentialService.prompterFromPromptedWebhook(
				promptedWebhook(ADA, BOB),
				{ id: BOB, name: "Bob" },
			),
		).toEqual({ linearUserId: BOB, name: "Bob", email: undefined });
		// Cyrus delegating to itself is non-human.
		expect(
			PrompterCredentialService.isNonHumanCreator(createdWebhook(APP_USER), {
				linearUserId: APP_USER,
			}),
		).toBe(true);
		expect(
			PrompterCredentialService.isNonHumanCreator(createdWebhook(ADA), {
				linearUserId: ADA,
			}),
		).toBe(false);
	});

	it("pins a mapped prompter and resolves distinct credentials per session (concurrency)", () => {
		const svc = service();
		const decision = svc.decideForNewSession({
			prompter: { linearUserId: ADA, name: "Ada" },
			isNonHuman: false,
		});
		expect(decision).toEqual({
			action: "use-user",
			linearUserId: ADA,
			source: "prompter",
		});
		const pin = PrompterCredentialService.pinFromDecision(decision as never, {
			linearUserId: ADA,
			name: "Ada",
		});
		const a1 = svc.resolveForSession({
			...session(pin),
			id: "sess-a1",
		} as CyrusAgentSession);
		const a2 = svc.resolveForSession({
			...session(pin),
			id: "sess-a2",
		} as CyrusAgentSession);
		expect(a1?.env.GH_TOKEN).toBe("github_pat_ada_placeholder");
		expect(a2?.env.GH_TOKEN).toBe("github_pat_ada_placeholder");
		// Each session gets its own env object — nothing shared or mutated.
		expect(a1?.env).not.toBe(a2?.env);
		expect(svc.describePin(pin)).toContain("Running as Ada");
	});

	it("re-reads the secret on every runner build so rotation is picked up", () => {
		const svc = service();
		const pin = {
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter" as const,
		};
		const before = svc.resolveForSession(session(pin));
		process.env.PCS_TEST_ADA_GH = "github_pat_ada_rotated_placeholder";
		const after = svc.resolveForSession(session(pin));
		expect(before?.fingerprints.github).not.toBe(after?.fingerprints.github);
		expect(after?.env.GH_TOKEN).toBe("github_pat_ada_rotated_placeholder");
	});

	it("throws a secret-free error when a pinned user's credential can no longer be read", () => {
		const svc = service();
		delete process.env.PCS_TEST_ADA_GH;
		const pin = {
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter" as const,
		};
		expect(() => svc.resolveForSession(session(pin))).toThrow(
			PrompterCredentialError,
		);
		try {
			svc.resolveForSession(session(pin));
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain("PCS_TEST_ADA_GH");
			expect(message).toContain("cyrus add-user");
			expect(message).not.toContain("sk-ant-oat01");
		}
	});

	it("rejects an unmapped human by default and an incomplete mapping at resolve time", () => {
		const svc = service();
		const unmapped = svc.decideForNewSession({
			prompter: { linearUserId: "lin-zoe", name: "Zoe" },
			isNonHuman: false,
		});
		expect(unmapped).toMatchObject({ action: "reject", reason: "not-mapped" });
		const bobPin = {
			linearUserId: BOB,
			credentialUserId: BOB,
			source: "prompter" as const,
		};
		expect(() => svc.resolveForSession(session(bobPin))).toThrow(
			/no Claude credential reference/,
		);
	});

	it("honours an explicit host opt-in and keeps host sessions on host credentials", () => {
		const svc = service({ policy: { unmappedPrompter: "host" } });
		const decision = svc.decideForNewSession({
			prompter: { linearUserId: "lin-zoe", name: "Zoe" },
			isNonHuman: false,
		});
		expect(decision?.action).toBe("host");
		const pin = PrompterCredentialService.pinFromDecision(decision as never, {
			linearUserId: "lin-zoe",
		});
		expect(pin.source).toBe("host");
		expect(svc.resolveForSession(session(pin))).toBeUndefined();
		expect(svc.describePin(pin)).toContain("host machine's credentials");
		// A later prompt from Ada does not switch the session to Ada.
		const follow = svc.decideForFollowUp({
			session: session(pin),
			prompter: { linearUserId: ADA },
		});
		expect(follow?.action).toBe("continue");
	});

	it("applies the follow-up policy: pin by default, reject when configured", () => {
		const pin = {
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter" as const,
		};
		const pinned = service().decideForFollowUp({
			session: session(pin),
			prompter: { linearUserId: BOB, name: "Bob" },
		});
		expect(pinned).toMatchObject({ action: "continue" });
		expect((pinned as { note?: string }).note).toContain("Bob");
		const rejected = service({
			policy: { followUpByOtherUser: "reject" },
		}).decideForFollowUp({
			session: session(pin),
			prompter: { linearUserId: BOB, name: "Bob" },
		});
		expect(rejected?.action).toBe("reject");
	});

	it("inherits the parent session's user for sub-issues Cyrus delegates to itself", () => {
		const svc = service();
		const parent = session({
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter",
		});
		const decision = svc.decideForNewSession({
			prompter: { linearUserId: APP_USER },
			isNonHuman: true,
			parentSession: parent,
		});
		expect(decision).toEqual({
			action: "use-user",
			linearUserId: ADA,
			source: "parent",
		});
	});

	it("validates a pin's secrets before any worktree exists", () => {
		const svc = service();
		const adaPin = {
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter" as const,
		};
		expect(svc.validatePin(adaPin)).toBeNull();
		delete process.env.PCS_TEST_ADA_CLAUDE;
		const problem = svc.validatePin(adaPin);
		expect(problem).toContain("PCS_TEST_ADA_CLAUDE");
		expect(problem).toContain("start a new session");
		expect(svc.validatePin({ linearUserId: "", source: "host" })).toBeNull();
	});

	it("hot-reloads the mapping", () => {
		const svc = service();
		svc.updateConfig({ linearUsers: {} });
		expect(svc.isEnabled()).toBe(false);
		// Removed mappings may leave secrets in process.env until restart.
		expect(svc.allEnvRefNames()).toContain("PCS_TEST_ADA_CLAUDE");
	});
});

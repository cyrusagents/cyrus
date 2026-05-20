import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIIssueTrackerService } from "../src/issue-tracker/adapters/CLIIssueTrackerService.js";
import type { InternalMessage } from "../src/messages/index.js";

describe("CLIIssueTrackerService.terminateIssue", () => {
	let service: CLIIssueTrackerService;

	beforeEach(() => {
		service = new CLIIssueTrackerService();
		service.seedDefaultData();
	});

	const createIssue = async () => {
		const issue = await service.createIssue({
			teamId: "team-default",
			title: "test issue",
			description: "",
		});
		return issue;
	};

	const setupMessageListener = () => {
		const messages: InternalMessage[] = [];
		const transport = service.createEventTransport({
			platform: "cli",
			fastifyServer: {} as FastifyInstance,
		});
		transport.on("message", (m: InternalMessage) => {
			messages.push(m);
		});
		return messages;
	};

	it("moves issue to state-done on action 'completed' and emits IssueStateChangeMessage", async () => {
		const messages = setupMessageListener();
		const issue = await createIssue();

		const identifier = await service.terminateIssue(issue.id, "completed");

		expect(identifier).toBe(issue.identifier);

		// state moved to state-done
		const updated = await service.fetchIssue(issue.id);
		expect(updated.stateId).toBe("state-done");

		// message emitted
		expect(messages).toHaveLength(1);
		const msg = messages[0]!;
		expect(msg.action).toBe("issue_state_change");
		expect(msg.workItemId).toBe(issue.id);
		expect(msg.workItemIdentifier).toBe(issue.identifier);
		expect((msg as { isTerminal: boolean }).isTerminal).toBe(true);
	});

	it("moves issue to state-canceled on action 'canceled' and emits message", async () => {
		const messages = setupMessageListener();
		const issue = await createIssue();

		await service.terminateIssue(issue.id, "canceled");

		const updated = await service.fetchIssue(issue.id);
		expect(updated.stateId).toBe("state-canceled");

		expect(messages).toHaveLength(1);
		expect(messages[0]!.action).toBe("issue_state_change");
	});

	it("removes issue from state on action 'deleted' and emits message", async () => {
		const messages = setupMessageListener();
		const issue = await createIssue();

		await service.terminateIssue(issue.id, "deleted");

		await expect(service.fetchIssue(issue.id)).rejects.toThrow();

		expect(messages).toHaveLength(1);
		expect(messages[0]!.workItemIdentifier).toBe(issue.identifier);
	});

	it("throws when the issue does not exist", async () => {
		await expect(
			service.terminateIssue("nonexistent-issue", "completed"),
		).rejects.toThrow(/not found/);
	});

	it("does not throw when there is no event transport (message simply not emitted)", async () => {
		const issue = await createIssue();
		// No transport created — terminateIssue should still update state silently
		await expect(service.terminateIssue(issue.id, "completed")).resolves.toBe(
			issue.identifier,
		);
	});
});

describe("CLIRPCServer terminateIssue command", () => {
	const buildServerAndHandler = async (service: CLIIssueTrackerService) => {
		const { CLIRPCServer } = await import(
			"../src/issue-tracker/adapters/CLIRPCServer.js"
		);

		type HandlerArgs = [
			{ body: unknown },
			{ send: (response: unknown) => void },
		];
		let handler: ((...args: HandlerArgs) => Promise<unknown>) | undefined;
		const fastifyStub = {
			post: (_path: string, fn: typeof handler) => {
				handler = fn;
			},
		} as unknown as FastifyInstance;

		new CLIRPCServer({
			fastifyServer: fastifyStub,
			issueTracker: service,
			version: "1.0.0",
		}).register();

		return async (body: unknown) => {
			let sent: unknown;
			const reply = { send: (response: unknown) => (sent = response) };
			await handler!({ body }, reply);
			return sent;
		};
	};

	it("routes 'terminateIssue' to handleTerminateIssue and returns identifier", async () => {
		const service = new CLIIssueTrackerService();
		service.seedDefaultData();
		const issue = await service.createIssue({
			teamId: "team-default",
			title: "rpc terminate test",
			description: "",
		});
		const spy = vi.spyOn(service, "terminateIssue");
		const call = await buildServerAndHandler(service);

		const response = (await call({
			jsonrpc: "2.0",
			method: "terminateIssue",
			params: { issueId: issue.id, action: "completed" },
			id: 1,
		})) as {
			result?: {
				success: boolean;
				identifier: string;
				action: string;
			};
			error?: { message: string };
		};

		expect(spy).toHaveBeenCalledWith(issue.id, "completed");
		expect(response.error).toBeUndefined();
		expect(response.result).toMatchObject({
			success: true,
			identifier: issue.identifier,
			action: "completed",
		});
	});

	it("returns INVALID_PARAMS for an unknown action", async () => {
		const service = new CLIIssueTrackerService();
		service.seedDefaultData();
		const call = await buildServerAndHandler(service);

		const response = (await call({
			jsonrpc: "2.0",
			method: "terminateIssue",
			params: { issueId: "issue-1", action: "archived" },
			id: 2,
		})) as { error?: { message: string } };

		expect(response.error).toBeDefined();
		expect(response.error!.message).toMatch(/Invalid action/);
	});

	it("returns INVALID_PARAMS when issueId is missing", async () => {
		const service = new CLIIssueTrackerService();
		service.seedDefaultData();
		const call = await buildServerAndHandler(service);

		const response = (await call({
			jsonrpc: "2.0",
			method: "terminateIssue",
			params: { action: "completed" },
			id: 3,
		})) as { error?: { message: string } };

		expect(response.error).toBeDefined();
		expect(response.error!.message).toMatch(/issueId is required/);
	});
});

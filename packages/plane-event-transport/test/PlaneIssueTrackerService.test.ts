import { describe, expect, it } from "vitest";
import {
	branchName,
	PlaneIssueTrackerService,
	toPlaneActivity,
} from "../src/PlaneIssueTrackerService.js";
import { htmlToText, markdownToHtml } from "../src/PlaneText.js";
import { BASE, fakePlane } from "./fakePlane.js";

const workItem = {
	id: "wi-1",
	name: "Fix the Login on mobile!",
	description_html: "<p>Steps:</p><ul><li>open app</li><li>tap login</li></ul>",
	sequence_id: 12,
	state: "s-2",
	priority: "high",
	labels: ["l-1"],
	assignees: [],
	parent: null,
	project: "p-1",
	created_at: "2026-11-01T10:00:00Z",
	updated_at: "2026-11-02T10:00:00Z",
};
const routes = {
	"GET /projects/p-1/work-items/wi-1/": workItem,
	"GET /projects/p-1/": { id: "p-1", name: "Web App", identifier: "WEB" },
	"GET /projects/p-1/states/": {
		results: [
			{ id: "s-1", name: "Todo", group: "unstarted", sequence: 1 },
			{ id: "s-2", name: "In Progress", group: "started", sequence: 2 },
			{ id: "s-3", name: "Cancelled", group: "cancelled", sequence: 3 },
		],
	},
	"GET /projects/p-1/labels/": [
		{ id: "l-1", name: "web-frontend" },
		{ id: "l-2", name: "Bug" },
	],
	"POST /runs/run-1/activities/": { id: "act-1" },
};

describe("PlaneIssueTrackerService", () => {
	it("reads labels and assignees that Plane returns as objects", async () => {
		const { api } = fakePlane({
			...routes,
			"GET /projects/p-1/work-items/wi-1/": {
				...workItem,
				labels: [{ id: "l-1", name: "web-frontend", parent: "l-9" }],
				assignees: [{ id: "u-1", display_name: "nor" }],
			},
		});
		const tracker = new PlaneIssueTrackerService(api, "plane:acme");
		tracker.rememberWorkItem("wi-1", "p-1");

		expect(await tracker.getIssueLabels("wi-1")).toEqual(["web-frontend"]);
		expect((await api.getWorkItem("p-1", "wi-1")).assignees).toEqual(["u-1"]);
	});

	it("presents a Plane work item as a Linear-shaped issue", async () => {
		const { api, calls } = fakePlane(routes);
		const tracker = new PlaneIssueTrackerService(api, "plane:acme");
		tracker.rememberWorkItem("wi-1", "p-1");

		const issue = await tracker.fetchIssue("wi-1");
		expect(issue.identifier).toBe("WEB-12");
		expect(issue.title).toBe("Fix the Login on mobile!");
		expect(issue.description).toBe("Steps:\n- open app\n- tap login");
		expect(issue.url).toBe(`${BASE}/acme/browse/WEB-12/`);
		expect(issue.branchName).toBe("web-12-fix-the-login-on-mobile");
		expect(issue.priority).toBe(2);
		expect(await issue.state).toMatchObject({
			name: "In Progress",
			type: "started",
		});
		expect(await issue.team).toMatchObject({
			id: "p-1",
			key: "WEB",
			name: "Web App",
		});
		expect(await issue.project).toEqual({ id: "p-1", name: "Web App" });
		expect(await tracker.getIssueLabels("wi-1")).toEqual(["web-frontend"]);
		expect(
			(await tracker.fetchWorkflowStates("p-1")).nodes.map((s) => s.type),
		).toEqual(["unstarted", "started", "canceled"]);
		// Authenticated as the bot.
		expect(calls[0]!.url).toBe(`${BASE}/auth/o/token/`);
	});

	it("posts activities to the agent run with the bot token", async () => {
		const { api, calls, fetchImpl } = fakePlane(routes);
		const tracker = new PlaneIssueTrackerService(api, "plane:acme");
		const result = await tracker.createAgentActivity({
			agentSessionId: "run-1",
			content: { type: "response", body: "Done: PR #5" },
		} as never);
		expect(result.success).toBe(true);
		expect(await result.agentActivity).toEqual({ id: "act-1" });
		const post = calls.find((c) => c.url.endsWith("/runs/run-1/activities/"))!;
		// Responses become comments: Markdown is sent as HTML.
		expect(post.body).toEqual({
			type: "response",
			content: { type: "response", body: "<p>Done: PR #5</p>" },
		});
		const init = fetchImpl.mock.calls.at(-1)![1] as RequestInit;
		expect((init.headers as Record<string, string>).Authorization).toBe(
			"Bearer bot-token",
		);
	});

	it("sends a heartbeat thought for a run silent for over 4 minutes, and stops after a response", async () => {
		const { api, calls } = fakePlane(routes);
		const tracker = new PlaneIssueTrackerService(api, "plane:acme");
		await tracker.createAgentActivity({
			agentSessionId: "run-1",
			content: { type: "thought", body: "Reading the code" },
		} as never);
		const activityPosts = () =>
			calls.filter((c) => c.url.endsWith("/activities/"));

		await tracker.sendHeartbeats(Date.now() + 60_000);
		expect(activityPosts()).toHaveLength(1); // not silent long enough
		await tracker.sendHeartbeats(Date.now() + 5 * 60_000);
		expect(activityPosts()).toHaveLength(2);
		expect(activityPosts()[1]!.body).toEqual({
			type: "thought",
			content: { type: "thought", body: "Still working…" },
		});

		await tracker.createAgentActivity({
			agentSessionId: "run-1",
			content: { type: "response", body: "done" },
		} as never);
		await tracker.sendHeartbeats(Date.now() + 60 * 60_000);
		expect(activityPosts()).toHaveLength(3); // the response, no more heartbeats
		tracker.dispose();
	});
});

describe("toPlaneActivity", () => {
	it("maps actions to string parameters", () => {
		expect(
			toPlaneActivity({
				agentSessionId: "r",
				content: {
					type: "action",
					action: "Bash",
					parameter: "pnpm test",
					result: { ok: true },
				},
			} as never),
		).toEqual({
			type: "action",
			content: {
				type: "action",
				action: "Bash",
				parameters: { parameter: "pnpm test", result: '{"ok":true}' },
			},
		});
	});

	it("maps select options and the auth signal to Plane's shapes", () => {
		expect(
			toPlaneActivity({
				agentSessionId: "r",
				content: { type: "elicitation", body: "Which repo?" },
				signal: "select",
				signalMetadata: {
					options: [{ value: "web-frontend" }, { value: "web-admin" }],
				},
			} as never),
		).toEqual({
			type: "elicitation",
			content: { type: "elicitation", body: "<p>Which repo?</p>" },
			signal: "select",
			signal_metadata: {
				options: [
					{ id: "web-frontend", label: "web-frontend" },
					{ id: "web-admin", label: "web-admin" },
				],
			},
		});
		expect(
			toPlaneActivity({
				agentSessionId: "r",
				content: { type: "elicitation", body: "Log in" },
				signal: "auth",
				signalMetadata: { url: "https://x" },
			} as never).signal,
		).toBe("auth_request");
	});
});

describe("text helpers", () => {
	it("reads Plane HTML as text and writes Markdown as HTML", () => {
		expect(
			htmlToText("<p>Hello &lt;b&gt;<br>line 2</p><p>Next &amp; last</p>"),
		).toBe("Hello <b>\nline 2\nNext & last");
		// No newlines between tags: Plane shows each as an empty block.
		expect(markdownToHtml("**Done**\n\n- one `x`\nline\n- two")).toBe(
			"<p><strong>Done</strong></p><ul><li>one <code>x</code><br>line</li><li>two</li></ul>",
		);
		// Code blocks keep their lines.
		expect(markdownToHtml("```\na > b\n<c>\n```")).toBe(
			"<pre><code>a &gt; b\n&lt;c&gt;\n</code></pre>",
		);
		expect(markdownToHtml("  ")).toBe("");
	});

	it("builds Linear-style branch names", () => {
		expect(branchName("WEB-3", "Éditer le Solde !!")).toBe(
			"web-3-editer-le-solde",
		);
		expect(branchName("WEB-4", "!!!")).toBe("web-4");
	});
});

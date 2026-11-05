import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createPlaneToolsServer } from "../src/mcp/PlaneToolsServer.js";
import { BASE, fakePlane } from "./fakePlane.js";

const routes = {
	"GET /work-items/WEB-12/": {
		id: "wi-1",
		name: "Login broken",
		sequence_id: 12,
		project: "p-1",
		state: "s-1",
	},
	"GET /projects/p-1/": { id: "p-1", name: "Web App", identifier: "WEB" },
	"GET /projects/p-1/states/": [
		{ id: "s-1", name: "In Progress", group: "started", sequence: 1 },
		{ id: "s-2", name: "In Review", group: "started", sequence: 2 },
	],
	"POST /projects/p-1/work-items/wi-1/comments/": { id: "c-9" },
	"PATCH /projects/p-1/work-items/wi-1/": { id: "wi-1" },
	"GET /projects/p-1/work-items/wi-1/attachments/": [
		{
			id: "a-1",
			attributes: { name: "brief.xlsx", type: "x" },
			is_uploaded: true,
		},
		{
			id: "a-2",
			attributes: { name: "brief.xlsx", type: "x" },
			is_uploaded: true,
		},
		{ id: "a-3", attributes: { name: "half.png" }, is_uploaded: false },
	],
	"GET /projects/p-1/work-items/wi-1/attachments/a-1/": new Response(null, {
		status: 302,
		headers: { location: "/uploads/one?sig=1" },
	}),
	"GET /projects/p-1/work-items/wi-1/attachments/a-2/": new Response(null, {
		status: 302,
		headers: { location: "/uploads/two?sig=2" },
	}),
	"GET /projects/p-1/work-items/wi-1/links/": [
		{ id: "k-1", url: "https://github.com/o/r/pull/7", title: "PR #7: Old" },
	],
	"PATCH /projects/p-1/work-items/wi-1/links/k-1/": { id: "k-1" },
	"POST /projects/p-1/work-items/wi-1/links/": {
		id: "k-2",
		url: "https://github.com/o/r/pull/8",
		title: "PR #8: New",
	},
	[`GET ${BASE}/uploads/one?sig=1`]: new Response("first"),
	[`GET ${BASE}/uploads/two?sig=2`]: new Response("second"),
};

async function connect() {
	const plane = fakePlane(routes);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createPlaneToolsServer(plane.api).connect(serverSide);
	const client = new Client({ name: "test", version: "0" });
	await client.connect(clientSide);
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = (await client.callTool({ name, arguments: args })) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		return { isError: Boolean(result.isError), text: result.content[0]!.text };
	};
	return { call, calls: plane.calls };
}

describe("Plane tools MCP server", () => {
	it("posts a comment as Markdown HTML, mentions first", async () => {
		const { call, calls } = await connect();
		const result = await call("add_comment", {
			identifier: "WEB-12",
			body: "**Done**: PR merged",
			mention: ["u-7"],
		});
		expect(result.isError).toBe(false);
		const post = calls.find(
			(c) => c.method === "POST" && c.url.endsWith("/comments/"),
		);
		expect(post?.body).toEqual({
			comment_html:
				'<p><mention-component entity_identifier="u-7" entity_name="user_mention"></mention-component></p><p><strong>Done</strong>: PR merged</p>',
		});
	});

	it("moves a work item to a state by name, ignoring case", async () => {
		const { call, calls } = await connect();
		const result = await call("set_state", {
			identifier: "WEB-12",
			state: "in review",
		});
		expect(JSON.parse(result.text)).toEqual({
			identifier: "WEB-12",
			state: "In Review",
			group: "started",
		});
		expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
			state: "s-2",
		});
	});

	it("downloads attachments into the directory, keeping both of two same-named files", async () => {
		const { call, calls } = await connect();
		const dir = join(await mkdtemp(join(tmpdir(), "plane-att-")), "inputs");
		const result = await call("download_attachments", {
			identifier: "WEB-12",
			directory: dir,
		});
		expect(result.isError).toBe(false);
		const { files } = JSON.parse(result.text);
		expect(files.map((f: { name: string }) => f.name)).toEqual([
			"brief.xlsx",
			"brief (2).xlsx",
		]);
		expect(await readFile(join(dir, "brief.xlsx"), "utf8")).toBe("first");
		expect(await readFile(join(dir, "brief (2).xlsx"), "utf8")).toBe("second");
		// The signed storage URL is fetched without the bot token.
		const storage = calls.find((c) => c.url.startsWith(`${BASE}/uploads/`));
		expect(storage).toBeDefined();
	});

	it("adds a PR link, and retitles it when the URL is already linked", async () => {
		const { call, calls } = await connect();
		const added = await call("add_link", {
			identifier: "WEB-12",
			url: "https://github.com/o/r/pull/8",
			title: "PR #8: New",
		});
		expect(JSON.parse(added.text)).toMatchObject({ created: true });
		expect(
			calls.find((c) => c.method === "POST" && c.url.endsWith("/links/"))?.body,
		).toEqual({
			url: "https://github.com/o/r/pull/8",
			title: "PR #8: New",
		});

		const merged = await call("add_link", {
			identifier: "WEB-12",
			url: "https://github.com/o/r/pull/7",
			title: "PR #7: Old (merged)",
		});
		expect(JSON.parse(merged.text)).toMatchObject({ created: false });
		expect(
			calls.find((c) => c.method === "PATCH" && c.url.endsWith("/links/k-1/"))
				?.body,
		).toEqual({
			title: "PR #7: Old (merged)",
		});
	});

	it("refuses a relative download directory", async () => {
		const { call } = await connect();
		const result = await call("download_attachments", {
			identifier: "WEB-12",
			directory: "inputs",
		});
		expect(result).toEqual({
			isError: true,
			text: "directory must be an absolute path",
		});
	});

	it("names the available states when the state is unknown", async () => {
		const { call, calls } = await connect();
		const result = await call("set_state", {
			identifier: "WEB-12",
			state: "Shipped",
		});
		expect(result).toEqual({
			isError: true,
			text: 'WEB-12 has no state "Shipped". Available: In Progress, In Review',
		});
		expect(calls.some((c) => c.method === "PATCH")).toBe(false);
	});
});

import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PlaneApiClient } from "../PlaneApiClient.js";
import { htmlToText, markdownToHtml } from "../PlaneText.js";
import type {
	PlaneAttachment,
	PlaneCredentials,
	PlaneMember,
	PlaneWorkItem,
} from "../types.js";

/** Comments returned by get_work_item, newest last. */
const MAX_COMMENTS = 30;

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function ok(data: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: message }], isError: true };
}

function memberName(member: PlaneMember | undefined): string | undefined {
	if (!member) return undefined;
	const full = [member.first_name, member.last_name].filter(Boolean).join(" ");
	return member.display_name || full || member.email;
}

function attachmentName(a: PlaneAttachment): string {
	return basename(a.attributes?.name || a.asset?.split("/").pop() || a.id);
}

/** `name`, or `name (2).ext` etc. if a file of that name was already saved. */
function uniqueName(name: string, used: Set<string>): string {
	let candidate = name;
	for (let n = 2; used.has(candidate); n++) {
		const dot = name.lastIndexOf(".");
		candidate =
			dot > 0
				? `${name.slice(0, dot)} (${n})${name.slice(dot)}`
				: `${name} (${n})`;
	}
	used.add(candidate);
	return candidate;
}

/** A mention chip; Plane notifies the user when the comment is saved. */
function mentionHtml(userId: string): string {
	return `<mention-component entity_identifier="${userId}" entity_name="user_mention"></mention-component>`;
}

const identifierSchema = z
	.string()
	.describe('The work item\'s identifier, e.g. "WEB-12"');

/**
 * MCP tools for an agent working on a Plane work item: read it, comment,
 * and move it between states. Every call is made as the app's bot user, so
 * comments and changes show as the agent's.
 */
export function createPlaneToolsServer(api: PlaneApiClient): McpServer {
	const server = new McpServer({ name: "plane", version: "1.0.0" });

	const workItemUrl = (identifier: string) =>
		`${api.baseUrl}/${api.workspaceSlug}/browse/${identifier}/`;

	async function load(identifier: string) {
		const workItem: PlaneWorkItem =
			await api.getWorkItemByIdentifier(identifier);
		const project = await api.getProject(workItem.project);
		return {
			workItem,
			project,
			identifier: `${project.identifier}-${workItem.sequence_id}`,
		};
	}

	server.registerTool(
		"get_work_item",
		{
			description:
				"Read a Plane work item: title, state, priority, labels, assignees, description, attached files and recent comments. Use download_attachments to read the files.",
			inputSchema: { identifier: identifierSchema },
		},
		async ({ identifier }) => {
			try {
				const { workItem, project, identifier: id } = await load(identifier);
				const [states, labels, members, comments, attachments] =
					await Promise.all([
						api.listStates(project.id),
						api.listLabels(project.id),
						api.listMembers(),
						api.listComments(project.id, workItem.id),
						api.listAttachments(project.id, workItem.id),
					]);
				const byId = new Map(members.map((m) => [m.id, m]));
				const state = states.find((s) => s.id === workItem.state);
				return ok({
					identifier: id,
					url: workItemUrl(id),
					title: workItem.name,
					project: { id: project.id, name: project.name },
					state: state ? { name: state.name, group: state.group } : null,
					priority: workItem.priority ?? "none",
					labels: labels
						.filter((l) => workItem.labels?.includes(l.id))
						.map((l) => l.name),
					assignees: (workItem.assignees ?? []).map((uid) => ({
						id: uid,
						name: memberName(byId.get(uid)) ?? uid,
					})),
					description: htmlToText(
						workItem.description_html ?? workItem.description_stripped ?? "",
					),
					attachments: attachments
						.filter((a) => a.is_uploaded !== false)
						.map((a) => ({
							name: attachmentName(a),
							type: a.attributes?.type ?? null,
							size: a.attributes?.size ?? a.size ?? null,
						})),
					comments: [...comments]
						.sort((a, b) => a.created_at.localeCompare(b.created_at))
						.slice(-MAX_COMMENTS)
						.map((c) => ({
							id: c.id,
							author: c.actor
								? (memberName(byId.get(c.actor)) ?? c.actor)
								: null,
							createdAt: c.created_at,
							text: htmlToText(c.comment_html ?? c.comment_stripped ?? ""),
						})),
				});
			} catch (error) {
				return fail(error);
			}
		},
	);

	server.registerTool(
		"add_comment",
		{
			description:
				"Post a comment on a Plane work item, as the agent. The body is Markdown. To notify people, pass their user ids in mention (see list_members); the mentions go at the start of the comment.",
			inputSchema: {
				identifier: identifierSchema,
				body: z.string().min(1).describe("The comment, in Markdown"),
				mention: z
					.array(z.string())
					.optional()
					.describe("User ids to mention (notified by Plane)"),
			},
		},
		async ({ identifier, body, mention }) => {
			try {
				const { workItem, project, identifier: id } = await load(identifier);
				const mentions = (mention ?? []).map(mentionHtml).join(" ");
				const html =
					(mentions ? `<p>${mentions}</p>` : "") + markdownToHtml(body);
				const comment = await api.createComment(project.id, workItem.id, html);
				return ok({ id: comment.id, url: workItemUrl(id) });
			} catch (error) {
				return fail(error);
			}
		},
	);

	server.registerTool(
		"download_attachments",
		{
			description:
				"Download the files attached to a Plane work item (screenshots, spreadsheets, documents...) into a directory, e.g. your working directory, so you can open them. Returns each file's path.",
			inputSchema: {
				identifier: identifierSchema,
				directory: z
					.string()
					.describe(
						"Absolute path of the directory to save into; created if missing",
					),
			},
		},
		async ({ identifier, directory }) => {
			try {
				if (!isAbsolute(directory)) {
					return fail("directory must be an absolute path");
				}
				const { workItem, project, identifier: id } = await load(identifier);
				const attachments = (
					await api.listAttachments(project.id, workItem.id)
				).filter((a) => a.is_uploaded !== false);
				await mkdir(directory, { recursive: true });
				const used = new Set<string>();
				const files = [];
				for (const a of attachments) {
					const name = uniqueName(attachmentName(a), used);
					const data = await api.downloadAttachment(
						project.id,
						workItem.id,
						a.id,
					);
					const path = join(directory, name);
					await writeFile(path, data);
					files.push({
						name,
						path,
						size: data.length,
						type: a.attributes?.type ?? null,
					});
				}
				return ok({ identifier: id, files });
			} catch (error) {
				return fail(error);
			}
		},
	);

	server.registerTool(
		"add_link",
		{
			description:
				'Attach a link to a Plane work item, e.g. the pull request or merge request you opened ("PR #20: Fix login"). Calling it again with the same URL updates the title, e.g. to add "(merged)".',
			inputSchema: {
				identifier: identifierSchema,
				url: z.string().url().describe("The link, e.g. the PR's URL"),
				title: z
					.string()
					.min(1)
					.describe('Shown in Plane, e.g. "PR #20: Fix login"'),
			},
		},
		async ({ identifier, url, title }) => {
			try {
				const { workItem, project, identifier: id } = await load(identifier);
				const link = await api.upsertLink(project.id, workItem.id, url, title);
				return ok({
					identifier: id,
					url: link.url,
					title: link.title ?? title,
					created: link.created,
				});
			} catch (error) {
				return fail(error);
			}
		},
	);

	server.registerTool(
		"list_states",
		{
			description:
				"List the states a Plane work item can move to (its project's workflow), in order.",
			inputSchema: { identifier: identifierSchema },
		},
		async ({ identifier }) => {
			try {
				const { workItem, project } = await load(identifier);
				const states = await api.listStates(project.id);
				return ok(
					[...states]
						.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
						.map((s) => ({
							name: s.name,
							group: s.group,
							current: s.id === workItem.state,
						})),
				);
			} catch (error) {
				return fail(error);
			}
		},
	);

	server.registerTool(
		"set_state",
		{
			description:
				'Move a Plane work item to another state, by name (e.g. "In Review", "Done"). Matching ignores case.',
			inputSchema: {
				identifier: identifierSchema,
				state: z.string().min(1).describe("The state's name"),
			},
		},
		async ({ identifier, state }) => {
			try {
				const { workItem, project, identifier: id } = await load(identifier);
				const states = await api.listStates(project.id);
				const target = states.find(
					(s) => s.name.toLowerCase() === state.trim().toLowerCase(),
				);
				if (!target) {
					return fail(
						`${id} has no state "${state}". Available: ${states.map((s) => s.name).join(", ")}`,
					);
				}
				await api.updateWorkItem(project.id, workItem.id, {
					state: target.id,
				});
				return ok({ identifier: id, state: target.name, group: target.group });
			} catch (error) {
				return fail(error);
			}
		},
	);

	server.registerTool(
		"list_members",
		{
			description:
				"List the Plane workspace's members (id, name, email), e.g. to mention someone in add_comment.",
			inputSchema: {},
		},
		async () => {
			try {
				const members = await api.listMembers();
				return ok(
					members.map((m) => ({
						id: m.id,
						name: memberName(m),
						email: m.email,
					})),
				);
			} catch (error) {
				return fail(error);
			}
		},
	);

	return server;
}

/**
 * How Claude Code starts the Plane tools for a session: this package's
 * stdio entry point, run with the current Node, authenticated as the bot.
 */
export function planeToolsMcpServerConfig(credentials: PlaneCredentials): {
	type: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
} {
	return {
		type: "stdio",
		command: process.execPath,
		args: [fileURLToPath(new URL("./stdio.js", import.meta.url))],
		env: {
			PLANE_BASE_URL: credentials.baseUrl,
			PLANE_WORKSPACE_SLUG: credentials.workspaceSlug,
			PLANE_CLIENT_ID: credentials.clientId,
			PLANE_CLIENT_SECRET: credentials.clientSecret,
			PLANE_APP_INSTALLATION_ID: credentials.appInstallationId,
		},
	};
}

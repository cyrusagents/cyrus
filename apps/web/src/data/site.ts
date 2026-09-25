export const site = {
	name: "Miko",
	title: "Miko — Self-Hosted AI Coding Agent | Slack, Linear, GitHub",
	description:
		"Self-hosted, open-source coding agent. Connect Slack, Linear, GitHub or GitLab to Claude Code, Codex and Cursor — assign a task, get a reviewed pull request.",
	locale: "en_US",
	lang: "en",
	themeColor: "#ffffff",
	themeColorDark: "#0a0a0a",
	robots:
		"index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
	image: "/og.jpg",
	imageAlt: "Miko, a self-hosted background coding agent",
	imageWidth: 1200,
	imageHeight: 630,
	github: "https://github.com/mikoagents/miko",
	license: "https://github.com/mikoagents/miko/blob/main/LICENSE",
} as const;

export const faqs = [
	{
		question: "What is Miko?",
		answer:
			"A self-hosted background coding agent that connects your tools to coding agents and returns work for you to review.",
	},
	{
		question: "Which coding agents can I use?",
		answer:
			"Claude Code, Codex, Cursor, Grok, Gemini, and OpenCode. Configure your runner and model with supported provider credentials.",
	},
	{
		question: "How do I start?",
		answer:
			"Add the setup skills with npx skills add mikoagents/miko -g, then run /miko-setup in your coding agent. It guides installation and connections.",
	},
	{
		question: "Where do I give it work?",
		answer:
			"Assign a Linear issue to Miko, or @Miko in a GitHub PR, GitLab MR, or Slack conversation. Connect each integration during setup; use the bot handle you configured.",
	},
	{
		question: "How is model usage paid for?",
		answer:
			"Bring your own supported API credentials or subscription authentication. Provider usage and hosting costs are yours. The source is Apache 2.0.",
	},
	{
		question: "How are tasks separated?",
		answer:
			"Tasks run in separate Git worktrees. Repository routing sends work to the configured repository, keeping working directories apart.",
	},
	{
		question: "Where does my code run?",
		answer:
			"On your machine or server. The selected coding provider processes requests under your configured account. Follow tasks and searchable logs on the local status board.",
	},
] as const;

export const indexablePaths = ["/"] as const;

export function absoluteUrl(origin: URL, path: string) {
	return new URL(path, origin).href;
}

export function homeJsonLd(origin: URL) {
	const url = absoluteUrl(origin, "/");
	const image = absoluteUrl(origin, site.image);
	const logo = absoluteUrl(origin, "/icon-512.png");
	return {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Organization",
				"@id": `${url}#organization`,
				name: site.name,
				url,
				logo: {
					"@type": "ImageObject",
					url: logo,
				},
				sameAs: [site.github],
			},
			{
				"@type": "WebSite",
				"@id": `${url}#website`,
				name: site.name,
				url,
				description: site.description,
				inLanguage: site.lang,
				publisher: { "@id": `${url}#organization` },
			},
			{
				"@type": "SoftwareApplication",
				"@id": `${url}#software`,
				name: site.name,
				applicationCategory: "DeveloperApplication",
				url,
				description: site.description,
				image,
				isAccessibleForFree: true,
				featureList: [
					"Linear, GitHub, GitLab, Slack, and Zulip",
					"Claude Code, Codex, Cursor, Grok, Gemini, and OpenCode",
					"Isolated Git worktrees",
					"Bring your own model credentials",
					"Local status board",
				],
				author: { "@id": `${url}#organization` },
				publisher: { "@id": `${url}#organization` },
			},
			{
				"@type": "SoftwareSourceCode",
				"@id": `${url}#source`,
				name: site.name,
				codeRepository: site.github,
				url: site.github,
				license: site.license,
				programmingLanguage: "TypeScript",
				isAccessibleForFree: true,
				author: { "@id": `${url}#organization` },
			},
			{
				"@type": ["WebPage", "FAQPage"],
				"@id": `${url}#webpage`,
				url,
				name: site.title,
				description: site.description,
				inLanguage: site.lang,
				isPartOf: { "@id": `${url}#website` },
				about: { "@id": `${url}#software` },
				publisher: { "@id": `${url}#organization` },
				primaryImageOfPage: {
					"@type": "ImageObject",
					url: image,
					width: site.imageWidth,
					height: site.imageHeight,
				},
				mainEntity: faqs.map((item) => ({
					"@type": "Question",
					name: item.question,
					acceptedAnswer: {
						"@type": "Answer",
						text: item.answer,
					},
				})),
			},
		],
	};
}

export function llmsText(origin: URL) {
	const home = absoluteUrl(origin, "/");
	const lines = [
		`# ${site.name}`,
		"",
		`> ${site.description}`,
		"",
		"Miko is a self-hosted background coding agent. Assign a Linear issue to Miko, or mention @Miko in GitHub, GitLab, Slack, or Zulip. The selected coding agent works in an isolated Git worktree and returns progress, answers, and pull requests. You bring your own model credentials and host the worker. The source is Apache 2.0.",
		"",
		"## Start",
		"",
		"1. Run `npx skills add mikoagents/miko -g` in a terminal.",
		"2. Run `/miko-setup` in your coding agent and follow the setup.",
		"3. Give Miko a task from Linear, GitHub, GitLab, or Slack.",
		"4. Open `/board` on the local server, usually `http://127.0.0.1:3456/board`, and read the task log.",
		"",
		"## Coding agents",
		"",
		"- Claude Code",
		"- Codex",
		"- Cursor",
		"- Grok",
		"- Gemini",
		"- OpenCode",
		"",
		"## Links",
		"",
		`- [Website](${home})`,
		`- [Source](${site.github})`,
		`- [Self-hosting](${site.github}/blob/main/docs/SELF_HOSTING.md)`,
		`- [Configuration](${site.github}/blob/main/docs/CONFIG_FILE.md)`,
		`- [License](${site.license})`,
		"",
	];
	return lines.join("\n");
}

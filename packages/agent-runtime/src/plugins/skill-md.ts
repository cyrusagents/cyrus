import type { PluginSkill } from "../types.js";

/**
 * Render a PluginSkill into a SKILL.md file body (YAML frontmatter +
 * markdown). The same format works for Claude, Cursor, and Codex.
 */
export function renderSkillMd(skill: PluginSkill): string {
	const frontmatter: string[] = [
		`name: ${skill.name}`,
		`description: ${yamlString(skill.description)}`,
	];
	if (skill.disableModelInvocation) {
		frontmatter.push("disable-model-invocation: true");
	}
	return `---\n${frontmatter.join("\n")}\n---\n\n${skill.content}\n`;
}

/**
 * Wrap a YAML scalar — if the description contains special chars (`:`,
 * `#`, newlines), use a double-quoted form. Otherwise plain.
 */
function yamlString(value: string): string {
	if (/[:#\n\\"]/.test(value)) {
		const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `"${escaped}"`;
	}
	return value;
}

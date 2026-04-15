import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	ApiResponse,
	DeleteSkillPayload,
	SkillInfo,
	UpdateSkillPayload,
} from "../types.js";

const USER_SKILLS_DIR = "user-skills-plugin/skills";

/** Only lowercase letters, numbers, hyphens, underscores allowed */
const VALID_SKILL_NAME = /^[a-z0-9_-]+$/;

/**
 * Validate and sanitize a skill name.
 * Prevents path traversal and enforces naming constraints.
 */
function validateSkillName(
	name: unknown,
): { valid: true; name: string } | { valid: false; error: ApiResponse } {
	if (!name || typeof name !== "string") {
		return {
			valid: false,
			error: {
				success: false,
				error: "Skill name is required",
				details: "The name field must be a non-empty string.",
			},
		};
	}

	if (!VALID_SKILL_NAME.test(name)) {
		return {
			valid: false,
			error: {
				success: false,
				error: "Invalid skill name",
				details:
					"Skill names may only contain lowercase letters, numbers, hyphens, and underscores.",
			},
		};
	}

	return { valid: true, name };
}

/**
 * Resolve the skill directory path and verify it stays within the skills root.
 * Prevents path traversal even if validation is bypassed.
 */
function resolveSkillDir(
	cyrusHome: string,
	skillName: string,
): { path: string } | { error: ApiResponse } {
	const skillsRoot = resolve(cyrusHome, USER_SKILLS_DIR);
	const skillDir = resolve(skillsRoot, skillName);

	if (!skillDir.startsWith(`${skillsRoot}/`)) {
		return {
			error: {
				success: false,
				error: "Invalid skill name",
				details:
					"Skill name must not contain path separators or traversal sequences.",
			},
		};
	}

	return { path: skillDir };
}

/**
 * Escape a string for safe inclusion as a YAML scalar value.
 * Wraps in double quotes if the value contains special characters.
 */
function yamlEscape(value: string): string {
	if (/[\n\r:"{}[\],&*?|>!%@`#]/.test(value) || value !== value.trim()) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}

/**
 * Handle creating or updating a user skill.
 * Writes a SKILL.md file to ~/.cyrus/user-skills-plugin/skills/<name>/SKILL.md
 */
export async function handleUpdateSkill(
	payload: UpdateSkillPayload,
	cyrusHome: string,
): Promise<ApiResponse> {
	try {
		const nameResult = validateSkillName(payload.name);
		if (!nameResult.valid) return nameResult.error;

		if (!payload.description || typeof payload.description !== "string") {
			return {
				success: false,
				error: "Skill description is required",
				details: "The description field must be a non-empty string.",
			};
		}

		if (!payload.content || typeof payload.content !== "string") {
			return {
				success: false,
				error: "Skill content is required",
				details: "The content field must be a non-empty string.",
			};
		}

		const dirResult = resolveSkillDir(cyrusHome, nameResult.name);
		if ("error" in dirResult) return dirResult.error;

		const skillPath = join(dirResult.path, "SKILL.md");

		// Build SKILL.md with YAML frontmatter (values escaped for safety)
		const skillContent = [
			"---",
			`name: ${yamlEscape(nameResult.name)}`,
			`description: ${yamlEscape(payload.description)}`,
			"---",
			"",
			payload.content,
		].join("\n");

		await mkdir(dirResult.path, { recursive: true });
		await writeFile(skillPath, skillContent, "utf-8");

		return {
			success: true,
			message: `Skill "${nameResult.name}" saved successfully`,
			data: {
				name: nameResult.name,
				path: skillPath,
			},
		};
	} catch (error) {
		return {
			success: false,
			error: "Failed to save skill",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Handle deleting a user skill.
 * Removes the skill directory from ~/.cyrus/user-skills-plugin/skills/<name>/
 */
export async function handleDeleteSkill(
	payload: DeleteSkillPayload,
	cyrusHome: string,
): Promise<ApiResponse> {
	try {
		const nameResult = validateSkillName(payload.name);
		if (!nameResult.valid) return nameResult.error;

		const dirResult = resolveSkillDir(cyrusHome, nameResult.name);
		if ("error" in dirResult) return dirResult.error;

		try {
			await rm(dirResult.path, { recursive: true });
		} catch (error: any) {
			if (error.code === "ENOENT") {
				return {
					success: false,
					error: `Skill "${nameResult.name}" not found`,
					details: `No skill directory exists at ${dirResult.path}`,
				};
			}
			throw error;
		}

		return {
			success: true,
			message: `Skill "${nameResult.name}" deleted successfully`,
			data: { name: nameResult.name },
		};
	} catch (error) {
		return {
			success: false,
			error: "Failed to delete skill",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Handle listing all user skills.
 * Reads skill directories from ~/.cyrus/user-skills-plugin/skills/
 * and returns name + description from each SKILL.md frontmatter.
 */
export async function handleListSkills(
	_payload: Record<string, never>,
	cyrusHome: string,
): Promise<ApiResponse> {
	try {
		const skillsDir = join(cyrusHome, USER_SKILLS_DIR);

		let entries: { isDirectory(): boolean; name: string }[];
		try {
			entries = await readdir(skillsDir, { withFileTypes: true });
		} catch (error: any) {
			if (error.code === "ENOENT") {
				return {
					success: true,
					message: "No user skills configured",
					data: { skills: [] },
				};
			}
			throw error;
		}

		const skills: SkillInfo[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const skillPath = join(skillsDir, entry.name, "SKILL.md");
			try {
				const content = await readFile(skillPath, "utf-8");
				const description = parseFrontmatterField(content, "description") || "";
				skills.push({ name: entry.name, description });
			} catch {
				// SKILL.md missing or unreadable — include with empty description
				skills.push({ name: entry.name, description: "" });
			}
		}

		return {
			success: true,
			message: `Found ${skills.length} user skill(s)`,
			data: { skills },
		};
	} catch (error) {
		return {
			success: false,
			error: "Failed to list skills",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Extract a field value from YAML frontmatter.
 */
function parseFrontmatterField(
	content: string,
	field: string,
): string | undefined {
	const match = content.match(
		new RegExp(`^---[\\s\\S]*?^${field}:\\s*(.+)$[\\s\\S]*?^---`, "m"),
	);
	return match?.[1]?.trim();
}

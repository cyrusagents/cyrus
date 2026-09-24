import { describe, expect, it } from "vitest";
import {
	formFromDefinition,
	inputFromForm,
	scheduleFromForm,
} from "../board/automation-model.mjs";

const options = {
	repositories: [{ id: "repo", workspaceId: "ws" }],
	workspaces: [{ id: "ws" }],
};
describe("automation form serialization", () => {
	it("preserves existing weekly rules, target and timezone through editing", () => {
		const input = {
			name: "Weekly maintenance",
			instructions: "Check dependencies",
			repositoryId: "repo",
			schedule: { kind: "weekly", days: [1, 5], time: "09:30" },
			timezone: "America/New_York",
			enabled: false,
			target: {
				kind: "linear_issue",
				workspaceId: "ws",
				teamId: "team",
				projectId: "project",
			},
		};
		expect(inputFromForm(formFromDefinition(input, options))).toEqual(input);
	});
	it("preserves the absolute instant of a one-time task in the browser's timezone", () => {
		const definition = {
			target: { kind: "direct_repository" },
			schedule: { kind: "once", at: "2028-10-05T01:30:00.000Z" },
			timezone: "America/New_York",
		};
		const form = formFromDefinition(definition, options);
		expect(scheduleFromForm(form)).toEqual(definition.schedule);
		expect(inputFromForm(form).timezone).toBe(
			Intl.DateTimeFormat().resolvedOptions().timeZone,
		);
	});
	it("rejects an empty weekly selection and an invalid appointment before sending", () => {
		expect(() =>
			scheduleFromForm({ kind: "weekly", days: [], time: "09:00" }),
		).toThrow("weekday");
		expect(() => scheduleFromForm({ kind: "once", at: "" })).toThrow(
			"date and time",
		);
	});
	it("omits inactive Linear fields when switching to direct execution", () => {
		const form = {
			...formFromDefinition(undefined, options),
			teamId: "old-team",
			projectId: "old-project",
		};
		expect(inputFromForm(form).target).toEqual({ kind: "direct_repository" });
		expect(form.workspaceId).toBe("ws");
	});
});

/**
 * Tests for the shared settingSources validation helper used to gate a
 * per-repository / per-runner override of the Claude Agent SDK's
 * settingSources option (see CYRUS-PATCH history: the option was previously
 * hardcoded to ["user", "project", "local"] everywhere).
 */

import { describe, expect, it } from "vitest";
import {
	isValidSettingSourcesOverride,
	VALID_SETTING_SOURCES,
} from "../src/config-schemas.js";

describe("isValidSettingSourcesOverride", () => {
	it("accepts a valid single-entry override", () => {
		expect(isValidSettingSourcesOverride(["project"])).toBe(true);
	});

	it("accepts a valid multi-entry override", () => {
		expect(isValidSettingSourcesOverride(["user", "local"])).toBe(true);
	});

	it("accepts all valid sources in any order", () => {
		expect(isValidSettingSourcesOverride(["local", "user", "project"])).toBe(
			true,
		);
	});

	it("rejects an empty array", () => {
		expect(isValidSettingSourcesOverride([])).toBe(false);
	});

	it("rejects an array containing an invalid entry", () => {
		expect(isValidSettingSourcesOverride(["user", "bogus"])).toBe(false);
	});

	it("rejects a non-array value", () => {
		expect(isValidSettingSourcesOverride("user")).toBe(false);
		expect(isValidSettingSourcesOverride(undefined)).toBe(false);
		expect(isValidSettingSourcesOverride(null)).toBe(false);
		expect(isValidSettingSourcesOverride(42)).toBe(false);
	});

	it("exposes the stock default source list", () => {
		expect(VALID_SETTING_SOURCES).toEqual(["user", "project", "local"]);
	});
});

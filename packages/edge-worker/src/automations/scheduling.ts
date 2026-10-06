import { type AutomationRegistration, digest } from "./contract.js";

/** Storage adapters use their authoritative database time, never a model's clock. */
export function latestTick(
	definition: AutomationRegistration,
	now: number,
	lastSlot: number | null,
) {
	if (definition.state !== "enabled" || !definition.schedule) return null;
	const anchor = Date.parse(definition.schedule.anchorAt);
	if (!Number.isFinite(now) || now < anchor) return null;
	const slot = Math.floor(
		(now - anchor) / (definition.schedule.intervalSeconds * 1000),
	);
	if (lastSlot !== null && slot <= lastSlot) return null;
	return {
		slot,
		scheduledAt: new Date(
			anchor + slot * definition.schedule.intervalSeconds * 1000,
		).toISOString(),
		key: digest([
			definition.workspaceId,
			definition.id,
			definition.revision,
			"tick",
			slot,
		]),
	};
}
export function instructionKey(
	definition: AutomationRegistration,
	eventId: string,
	trigger: "instruction" | "event" = "instruction",
): string {
	if (!eventId || eventId.length > 200)
		throw new Error("Stable event identity required");
	return digest([
		definition.workspaceId,
		definition.id,
		definition.revision,
		trigger,
		eventId,
	]);
}
export const AUTOMATION_LIMITS = Object.freeze({
	workspaceConcurrency: 2,
	definitionConcurrency: 1,
	queuedPerDefinition: 32,
	maxAttempts: 3,
	leaseSeconds: 90,
	pollMilliseconds: 15_000,
	renewMilliseconds: 5_000,
	maxSteps: 24,
});
export function retryDelayMilliseconds(attempt: number): number | null {
	if (
		!Number.isInteger(attempt) ||
		attempt < 1 ||
		attempt >= AUTOMATION_LIMITS.maxAttempts
	)
		return null;
	return 5000 * 2 ** (attempt - 1);
}

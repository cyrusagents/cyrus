/**
 * Shared test fixtures for Slack event transport tests
 */
import type {
	SlackAppMentionEvent,
	SlackEventEnvelope,
	SlackWebhookEvent,
} from "../src/types.js";

export const testAppMentionEvent: SlackAppMentionEvent = {
	type: "app_mention",
	user: "U1234567890",
	text: "<@U0BOT1234> Please fix the failing tests in the CI pipeline",
	ts: "1704110400.000100",
	channel: "C9876543210",
	event_ts: "1704110400.000100",
};

export const testThreadedAppMentionEvent: SlackAppMentionEvent = {
	type: "app_mention",
	user: "U1234567890",
	text: "<@U0BOT1234> Also check the linting errors",
	ts: "1704110500.000200",
	channel: "C9876543210",
	thread_ts: "1704110400.000100",
	event_ts: "1704110500.000200",
};

export const testEventEnvelope: SlackEventEnvelope = {
	token: "deprecated-token",
	team_id: "T0001",
	api_app_id: "A0001",
	event: testAppMentionEvent,
	type: "event_callback",
	event_id: "Ev0001",
	event_time: 1704110400,
};

export const testThreadedEventEnvelope: SlackEventEnvelope = {
	token: "deprecated-token",
	team_id: "T0001",
	api_app_id: "A0001",
	event: testThreadedAppMentionEvent,
	type: "event_callback",
	event_id: "Ev0002",
	event_time: 1704110500,
};

export const testUrlVerificationEnvelope: SlackEventEnvelope = {
	token: "deprecated-token",
	team_id: "T0001",
	api_app_id: "A0001",
	event: testAppMentionEvent,
	type: "url_verification",
	event_id: "Ev0003",
	event_time: 1704110400,
	challenge: "test-challenge-string",
};

export const testWebhookEvent: SlackWebhookEvent = {
	eventType: "app_mention",
	eventId: "Ev0001",
	payload: testAppMentionEvent,
	teamId: "T0001",
};

export const testThreadedWebhookEvent: SlackWebhookEvent = {
	eventType: "app_mention",
	eventId: "Ev0002",
	payload: testThreadedAppMentionEvent,
	teamId: "T0001",
};

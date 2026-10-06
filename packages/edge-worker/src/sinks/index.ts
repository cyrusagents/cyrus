/**
 * Activity sinks for posting agent session activities to various platforms.
 *
 * @module sinks
 */

export { DurableCyrusSessionSink } from "./DurableCyrusSessionSink.js";
export type {
	ActivityPostOptions,
	ActivityPostResult,
	ActivitySignal,
	CyrusSessionDescriptor,
	IActivitySink,
	ICyrusSessionSink,
	SessionActivitySink,
} from "./IActivitySink.js";
export { LinearActivitySink } from "./LinearActivitySink.js";
export { NoopActivitySink } from "./NoopActivitySink.js";
export { SessionActivityJournal } from "./SessionActivityJournal.js";
export {
	HttpSessionDeliveryTransport,
	type SessionDeliveryTransport,
} from "./SessionDeliveryTransport.js";
export * from "./session-delivery.js";

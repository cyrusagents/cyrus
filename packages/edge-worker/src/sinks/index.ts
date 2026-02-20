/**
 * Activity sinks for posting agent session activities to various platforms.
 *
 * @module sinks
 */

export type {
	ActivityPostOptions,
	ActivityPostResult,
	ActivitySignal,
	IActivitySink,
} from "./IActivitySink.js";
export { LinearActivitySink } from "./LinearActivitySink.js";
export { NoopActivitySink } from "./NoopActivitySink.js";

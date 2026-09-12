import { parentPort, workerData } from "node:worker_threads";
import { CursorRunner } from "./CursorRunner.js";
import type { CursorRunnerConfig } from "./types.js";

const port = parentPort!;
const { config, prompt } = workerData as {
	config: CursorRunnerConfig;
	prompt: string;
};
const runner = new CursorRunner(config);
runner.on("message", (message) =>
	port.postMessage({ type: "message", message }),
);
runner.on("error", (error) =>
	port.postMessage({ type: "error", message: error.message }),
);
port.on("message", (event) => {
	if (event.type === "stop") runner.stop();
});
try {
	const session = await runner.start(prompt);
	port.postMessage({ type: "done", session });
} catch (error) {
	port.postMessage({
		type: "failed",
		message: error instanceof Error ? error.message : String(error),
	});
} finally {
	port.close();
}

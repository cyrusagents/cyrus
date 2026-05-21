export * from "./compute-sdk.js";
export * from "./local.js";

import { compute } from "computesdk";
import type { SandboxProvider } from "../types.js";
import { createComputeSdkSandboxProvider } from "./compute-sdk.js";
import { createLocalSandboxProvider } from "./local.js";

export function createSandboxProvider(provider: string): SandboxProvider {
	if (provider === "local") {
		return createLocalSandboxProvider();
	}
	return createComputeSdkSandboxProvider({ compute });
}

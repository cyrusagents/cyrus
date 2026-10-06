import dotenv from "dotenv";

/** The launch-selected control plane must not change during auth or env reload. */
export function loadRuntimeEnv(path: string): void {
	const launchOrigin = process.env.CYRUS_APP_URL;
	dotenv.config({ path, override: true });
	if (launchOrigin) process.env.CYRUS_APP_URL = launchOrigin;
}

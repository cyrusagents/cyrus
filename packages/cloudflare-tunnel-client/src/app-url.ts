/** Optional operator-owned control plane. No hosted service is used by default. */
export function getAtmikoAppUrl(): string | undefined {
	return process.env.ATMIKO_APP_URL?.trim().replace(/\/+$/, "") || undefined;
}

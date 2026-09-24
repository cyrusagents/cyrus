/** Optional operator-owned control plane. No hosted service is used by default. */
export function getMikoAppUrl(): string | undefined {
	return process.env.MIKO_APP_URL?.trim().replace(/\/+$/, "") || undefined;
}

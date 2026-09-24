export function boardPageFromHash(hash) {
	return hash.replace(/\/$/, "") === "#/automations" ? "automations" : "tasks";
}

export function boardPageHref(page) {
	return page === "automations" ? "#/automations" : "#/tasks";
}

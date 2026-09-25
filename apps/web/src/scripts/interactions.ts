import cases from "../data/use-cases.json";

const $ = <T extends Element = HTMLElement>(
	selector: string,
	root: ParentNode = document,
) => root.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(
	selector: string,
	root: ParentNode = document,
) => Array.from(root.querySelectorAll<T>(selector));

// Every interaction is local to the demo. External actions remain ordinary links.
function showDialog(content: HTMLElement, label: string) {
	const dialog = document.createElement("dialog");
	dialog.className = "demo-dialog";
	dialog.setAttribute("aria-label", label);
	const close = document.createElement("button");
	close.className = "dialog-close";
	close.textContent = "×";
	close.setAttribute("aria-label", "Close");
	close.addEventListener("click", () => dialog.close());
	dialog.append(close, content);
	dialog.addEventListener("click", (event) => {
		if (event.target === dialog) dialog.close();
	});
	dialog.addEventListener("close", () => {
		dialog.remove();
	});
	document.body.append(dialog);
	dialog.showModal();
}

// Accessible FAQ accordion; preserve the original expanded first answer.
$$<HTMLButtonElement>("#faqs button[aria-controls]").forEach((button) => {
	button.addEventListener("click", () => {
		const isOpen = button.getAttribute("aria-expanded") === "true";
		const panel = document.getElementById(
			button.getAttribute("aria-controls")!,
		);
		button.setAttribute("aria-expanded", String(!isOpen));
		$("svg", button)?.classList.toggle("rotate-45", !isOpen);
		if (panel) {
			panel.hidden = isOpen;
			panel.style.height = isOpen ? "0px" : "auto";
			panel.style.opacity = isOpen ? "0" : "1";
		}
	});
});

const caseButtons = $$<HTMLButtonElement>("#use-cases button[data-pill-item]");
const activeStyle = caseButtons[0]?.getAttribute("style") ?? "";
const caseColors = [
	"cyan",
	"violet",
	"magenta",
	"green",
	"red",
	"red",
	"blue",
	"orange",
];
caseButtons.forEach((button) => {
	button.addEventListener("click", () => {
		const id = button.textContent!.trim().toLowerCase().replaceAll(" ", "-");
		const selected = cases.find((item) => item.id === id);
		if (!selected) return;
		caseButtons.forEach((item, index) => {
			const active = item === button;
			item.setAttribute("aria-pressed", String(active));
			item.style.cssText = active
				? activeStyle.replaceAll("cyan", caseColors[index]!)
				: "background: transparent; box-shadow: inset 0 0 0 1px var(--color-theme-border)";
			item.classList.toggle("pl-[5px]", active);
			item.classList.toggle("pl-3", !active);
			const avatarWrap = item.firstElementChild as HTMLElement;
			const avatar = avatarWrap.firstElementChild as HTMLElement;
			avatarWrap.style.width = active ? "28px" : "0px";
			avatar.style.opacity = active ? "1" : "0";
			avatar.style.transform = active ? "none" : "scale(0)";
			item.classList.toggle("text-theme-text/70", !active);
		});
		$$("#use-cases p.max-w-md").forEach((p) => {
			const split = selected.description.indexOf(". ") + 1;
			const lead = document.createElement("span");
			lead.className = "text-theme-text font-medium";
			lead.textContent = split
				? selected.description.slice(0, split)
				: selected.description;
			const detail = document.createElement("span");
			detail.className = "text-theme-text-muted font-normal";
			detail.textContent = split ? selected.description.slice(split + 1) : "";
			p.replaceChildren(lead, " ", detail);
		});
		$$("#use-cases [data-linear-case]").forEach((panel) => {
			panel.hidden = panel.dataset.linearCase !== id;
			if (!panel.hidden) panel.scrollTop = 0;
		});
	});
});

const themeButtons = $$<HTMLButtonElement>("footer [data-theme-toggle]");
function setTheme(dark: boolean) {
	document.documentElement.classList.toggle("dark", dark);
	document.documentElement.classList.toggle("light", !dark);
	for (const button of themeButtons) {
		button.setAttribute(
			"aria-label",
			`Switch to ${dark ? "light" : "dark"} mode`,
		);
	}
}
for (const button of themeButtons) {
	button.addEventListener("click", () => {
		const dark = !document.documentElement.classList.contains("dark");
		setTheme(dark);
		try {
			localStorage.setItem("grok-bot-theme", dark ? "dark" : "light");
		} catch {
			/* Storage is optional. */
		}
	});
}
try {
	if (localStorage.getItem("grok-bot-theme") === "dark") setTheme(true);
} catch {
	/* Storage is optional. */
}

$("[data-mobile-menu]")?.addEventListener("click", () => {
	const menu = document.createElement("nav");
	menu.className = "mobile-navigation";
	for (const link of $$("header nav ul a")) {
		const clone = link.cloneNode(true) as HTMLAnchorElement;
		clone.addEventListener("click", () => {
			menu.closest("dialog")?.close();
		});
		menu.append(clone);
	}
	showDialog(menu, "Navigation");
});

$$<HTMLButtonElement>("[data-copy-command]").forEach((button) => {
	button.addEventListener("click", async () => {
		const status = $(".quickstart-status");
		const code = button.closest(".quickstart-command")?.querySelector("code");
		const command = (
			button.dataset.copyCommand ||
			code?.innerText ||
			""
		).trim();
		try {
			await navigator.clipboard.writeText(command);
			for (const other of $$<HTMLButtonElement>("[data-copy-command]")) {
				if (other !== button) other.textContent = "Copy";
			}
			button.textContent = "Copied";
			if (status)
				status.textContent = button.dataset.copyStatus || "Prompt copied.";
		} catch {
			if (status) status.textContent = "Select and copy the text above.";
		}
	});
});

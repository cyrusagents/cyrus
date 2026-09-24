import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	vite: { plugins: [tailwindcss()] },
	devToolbar: { enabled: false },
});

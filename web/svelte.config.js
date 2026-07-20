import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Exists mainly so `bun run check` (svelte-check) can resolve the project;
// the vite plugin picks it up too and vitePreprocess matches its defaults.
export default { preprocess: vitePreprocess() };

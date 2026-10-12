import { fileURLToPath } from "node:url";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5178,
    // The chat protocol in ../shared is imported at runtime too; the dev
    // server only serves files under allowed roots (builds aren't affected).
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), fileURLToPath(new URL("../shared", import.meta.url))] },
    proxy: {
      // changeOrigin off (the string shorthand turns it on): the server's
      // request guard requires Origin to match Host, so keep the browser's.
      "/api": { target: "http://localhost:4553", changeOrigin: false },
      "/ws": { target: "ws://localhost:4553", ws: true },
    },
  },
});

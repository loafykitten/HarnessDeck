import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5178,
    proxy: {
      // changeOrigin off (the string shorthand turns it on): the server's
      // request guard requires Origin to match Host, so keep the browser's.
      "/api": { target: "http://localhost:4553", changeOrigin: false },
      "/ws": { target: "ws://localhost:4553", ws: true },
    },
  },
});

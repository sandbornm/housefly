import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: "node_modules/.vite-housefly",
  optimizeDeps: { entries: ["index.html"] },
  build: {
    rolldownOptions: {
      input: {
        housefly: "index.html",
        piano: "simulations/piano/index.html",
        flyout: "simulations/flyout/index.html",
        flypv: "simulations/flypv/index.html",
        flysim: "simulations/flysim/index.html",
      },
    },
  },
  server: {
    watch: { ignored: ["**/test-results/**", "**/docs/media/**"] },
    proxy: {
      "/api": "http://127.0.0.1:8787"
    }
  }
});

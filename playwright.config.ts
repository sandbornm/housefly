import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  timeout: 60_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 } }
  ],
  webServer: [
    { command: "npm run dev -- --port 5173 --strictPort", url: "http://127.0.0.1:5173", reuseExistingServer: true }
  ]
});

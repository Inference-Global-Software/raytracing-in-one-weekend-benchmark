import { defineConfig, devices } from '@playwright/test';

// Serves the staged web/ directory and runs the smoke test against it in
// headless Chromium. web/main.wasm is committed; to refresh it, run
// `infs build` and copy out/main.wasm over web/main.wasm.
export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx --yes http-server ../web -p 5174 -c-1 -s',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});

import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.local') });

/**
 * Signed-in acceptance suite (tests/acceptance). Writes to and deletes from
 * the real (dev) Supabase project, scoped to ONE throwaway `e2e-*` club and
 * admin created by global-setup and removed by global-teardown. Never part of
 * the default `playwright test` (see playwright.config.ts's testIgnore).
 *
 * Set ACCEPTANCE_BASE_URL to explicitly run against an already-running
 * server; otherwise `npm run dev` is started on the dedicated port 3100 and
 * Playwright errors if that port is already taken (never reuse a server, which
 * could be serving a different checkout's code).
 */
const externalBaseUrl = process.env.ACCEPTANCE_BASE_URL;

export default defineConfig({
  testDir: './tests/acceptance',
  globalSetup: './tests/acceptance/global-setup.ts',
  globalTeardown: './tests/acceptance/global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Unconditionally 0: tests mutate real project data; flakiness should surface.
  retries: 0,
  // Dev-server compile time makes first navigations slow.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'line',
  use: {
    baseURL: externalBaseUrl ?? 'http://localhost:3100',
    navigationTimeout: 60_000,
    // Off: a trace records locator.fill values, which would write the
    // throwaway admin's password into a trace zip.
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: 'npm run dev -- --port 3100',
          url: 'http://localhost:3100',
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
});

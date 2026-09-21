import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env.local') });

/**
 * Separate config for tests/integration/* -- these call server-side code
 * (createAdminClient()) directly against the real (dev) Supabase project,
 * not a page/browser, and must never run as part of the default
 * `npx playwright test` (which CI runs on every push/PR with no Supabase
 * credentials configured -- see playwright.config.ts's testIgnore).
 */
export default defineConfig({
  testDir: './tests/integration',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Unconditionally 0, not gated on CI: these tests mutate real project
  // data, so a flaky run should surface as a failure, not silently
  // multiply writes/leaks via retries.
  retries: 0,
  reporter: 'line',
  projects: [
    {
      name: 'integration',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

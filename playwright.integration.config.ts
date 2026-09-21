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
  fullyParallel: false,
  // Single worker: generateChaseEmails() (chase-generator.spec.ts) scans
  // and mutates chase_email for every active debt cycle across the whole
  // live dev project, not just rows scoped to its own test data. Run
  // concurrently with any other integration file that creates a
  // temporarily debt-eligible person (e.g. debt-calculation.spec.ts,
  // purchase-waivers.spec.ts), it can insert a chase_email row against
  // that file's person moments before that file's own afterEach deletes
  // the person -- either racing a duplicate chase_email insert or making
  // that delete fail on the chase_email FK. Forcing one worker serializes
  // all integration tests so no two ever run at the same time.
  workers: 1,
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

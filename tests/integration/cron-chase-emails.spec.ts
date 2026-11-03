import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { GET as cronGet } from "@/app/api/cron/chase-emails/route";

const admin = createAdminClient();

test.describe("GET /api/cron/chase-emails", () => {
  const originalSecret = process.env.CRON_SECRET;

  test.afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  test("rejects a missing/wrong bearer token with 401", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const request = new Request("http://localhost/api/cron/chase-emails", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    const response = await cronGet(request);
    expect(response.status).toBe(401);
  });

  test("processes every club, not just one", async () => {
    process.env.CRON_SECRET = "correct-secret";
    const request = new Request("http://localhost/api/cron/chase-emails", {
      headers: { authorization: "Bearer correct-secret" },
    });
    const response = await cronGet(request);
    expect(response.status).toBe(200);
    const body = await response.json();

    const { data: clubs, error } = await admin.from("club").select("slug");
    if (error) throw error;
    const processedSlugs = body.results.map((r: { clubSlug: string }) => r.clubSlug);
    for (const club of clubs ?? []) {
      expect(processedSlugs).toContain(club.slug);
    }
  });
});

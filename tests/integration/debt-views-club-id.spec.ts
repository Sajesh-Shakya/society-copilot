import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

test.describe("debt views expose club_id", () => {
  test("outstanding_attendance rows have a club_id column", async () => {
    const { data, error } = await admin.from("outstanding_attendance").select("club_id").limit(1);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  test("active_debt_cycle rows have a club_id column", async () => {
    const { data, error } = await admin.from("active_debt_cycle").select("club_id").limit(1);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});

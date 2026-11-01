import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminClubs } from "@/lib/auth/require-admin";

const admin = createAdminClient();

test.describe("listAdminClubs", () => {
  test("returns every club an email administers, with slug and name", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const email = `list-admin-clubs-${crypto.randomUUID()}@example.test`;
    await admin.from("admin").insert({ email, club_id: judo!.id });

    const clubs = await listAdminClubs(email);
    expect(clubs).toEqual([{ clubId: judo!.id, slug: "judo", name: "Judo" }]);

    await admin.from("admin").delete().eq("email", email);
  });

  test("returns an empty array for an email with no admin rows", async () => {
    const clubs = await listAdminClubs(`nobody-${crypto.randomUUID()}@example.test`);
    expect(clubs).toEqual([]);
  });

  test("returns multiple clubs for an email administering more than one", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const { data: tkd } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const email = `multi-club-${crypto.randomUUID()}@example.test`;
    await admin.from("admin").insert([
      { email, club_id: judo!.id },
      { email, club_id: tkd!.id },
    ]);

    const clubs = await listAdminClubs(email);
    expect(clubs.map((c) => c.slug).sort()).toEqual(["judo", "taekwondo"]);

    await admin.from("admin").delete().eq("email", email);
  });
});

// append to tests/integration/require-admin.spec.ts — this is the test that
// actually pins Review Focus item 1 ("a Judo admin must be refused on
// Taekwondo's URL"). requireAdmin() itself can't be unit-tested directly
// (it depends on a real authenticated request's cookies via
// lib/supabase/server.ts), so checkAdminForClub is the testable half that
// requireAdmin calls after resolving the signed-in user's email.
import { checkAdminForClub, UnauthorizedError } from "@/lib/auth/require-admin";

test.describe("checkAdminForClub", () => {
  test("rejects an admin of a different club", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const email = `cross-club-${crypto.randomUUID()}@example.test`;
    await admin.from("admin").insert({ email, club_id: judo!.id });

    await expect(checkAdminForClub(email, "taekwondo")).rejects.toThrow("Not authorized for this club.");
    await expect(checkAdminForClub(email, "judo")).resolves.toMatchObject({ clubId: judo!.id });

    await admin.from("admin").delete().eq("email", email);
  });

  test("gives the identical error for an unknown club slug and a known club the email doesn't administer", async () => {
    const email = `no-admin-${crypto.randomUUID()}@example.test`;
    let unknownClubMessage: string | undefined;
    let notAdminMessage: string | undefined;
    try {
      await checkAdminForClub(email, `unknown-${crypto.randomUUID()}`);
    } catch (e) {
      unknownClubMessage = (e as Error).message;
    }
    try {
      await checkAdminForClub(email, "judo");
    } catch (e) {
      notAdminMessage = (e as Error).message;
    }
    expect(unknownClubMessage).toBeDefined();
    expect(unknownClubMessage).toBe(notAdminMessage);
  });

  test("rejects with UnauthorizedError, not a bare Error", async () => {
    await expect(checkAdminForClub(`nobody-${crypto.randomUUID()}@example.test`, "judo")).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });
});

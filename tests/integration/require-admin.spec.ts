import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listAdminClubs } from "@/lib/auth/require-admin";

const admin = createAdminClient();

test.describe("listAdminClubs", () => {
  let emails: string[] = [];

  test.afterEach(async () => {
    if (emails.length) await admin.from("admin").delete().in("email", emails);
    emails = [];
  });

  test("returns every club an email administers, with slug and name", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const email = `list-admin-clubs-${crypto.randomUUID()}@example.test`;
    emails.push(email);
    await admin.from("admin").insert({ email, club_id: judo!.id });

    const clubs = await listAdminClubs(email);
    expect(clubs).toEqual([{ clubId: judo!.id, slug: "judo", name: "Judo" }]);
  });

  test("returns an empty array for an email with no admin rows", async () => {
    const clubs = await listAdminClubs(`nobody-${crypto.randomUUID()}@example.test`);
    expect(clubs).toEqual([]);
  });

  test("returns multiple clubs for an email administering more than one", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const { data: tkd } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
    const email = `multi-club-${crypto.randomUUID()}@example.test`;
    emails.push(email);
    await admin.from("admin").insert([
      { email, club_id: judo!.id },
      { email, club_id: tkd!.id },
    ]);

    const clubs = await listAdminClubs(email);
    expect(clubs.map((c) => c.slug).sort()).toEqual(["judo", "taekwondo"]);
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
  let emails: string[] = [];

  test.afterEach(async () => {
    if (emails.length) await admin.from("admin").delete().in("email", emails);
    emails = [];
  });

  test("rejects an admin of a different club", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const email = `cross-club-${crypto.randomUUID()}@example.test`;
    emails.push(email);
    await admin.from("admin").insert({ email, club_id: judo!.id });

    await expect(checkAdminForClub(email, "taekwondo")).rejects.toThrow("Not authorized for this club.");
    await expect(checkAdminForClub(email, "judo")).resolves.toMatchObject({ clubId: judo!.id });
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
  test("accepts a mixed-case email", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const lower = `mixed-case-${crypto.randomUUID()}@example.test`;
    emails.push(lower);
    await admin.from("admin").insert({ email: lower, club_id: judo!.id });

    const mixed = lower.replace(/^mixed-case/, "Mixed-Case").replace("@example", "@EXAMPLE");
    await expect(checkAdminForClub(mixed, "judo")).resolves.toEqual({ clubId: judo!.id, clubName: "Judo" });
  });

  test("gives the identical message for unknown slug and non-admin", async () => {
    const email = `same-msg-${crypto.randomUUID()}@example.test`;
    const unknown = await checkAdminForClub(email, `unknown-${crypto.randomUUID()}`).catch((e) => e);
    const notAdmin = await checkAdminForClub(email, "judo").catch((e) => e);
    expect(unknown).toBeInstanceOf(UnauthorizedError);
    expect(notAdmin).toBeInstanceOf(UnauthorizedError);
    expect(unknown.message).toBe("Not authorized for this club.");
    expect(notAdmin.message).toBe(unknown.message);
  });

  test("returns the right club for an admin of both judo and taekwondo", async () => {
    const { data: judo } = await admin.from("club").select("id, name").eq("slug", "judo").single();
    const { data: tkd } = await admin.from("club").select("id, name").eq("slug", "taekwondo").single();
    const email = `both-clubs-${crypto.randomUUID()}@example.test`;
    emails.push(email);
    await admin.from("admin").insert([
      { email, club_id: judo!.id },
      { email, club_id: tkd!.id },
    ]);

    await expect(checkAdminForClub(email, "taekwondo")).resolves.toEqual({ clubId: tkd!.id, clubName: tkd!.name });
    await expect(checkAdminForClub(email, "judo")).resolves.toEqual({ clubId: judo!.id, clubName: judo!.name });
  });

  test("deleting the admin row makes the next call refuse", async () => {
    const { data: judo } = await admin.from("club").select("id").eq("slug", "judo").single();
    const email = `revoked-${crypto.randomUUID()}@example.test`;
    emails.push(email);
    await admin.from("admin").insert({ email, club_id: judo!.id });
    await expect(checkAdminForClub(email, "judo")).resolves.toMatchObject({ clubId: judo!.id });

    await admin.from("admin").delete().eq("email", email);
    await expect(checkAdminForClub(email, "judo")).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

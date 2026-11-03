import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";
import { listActiveDebtCycles } from "@/lib/chase/debt-cycles";

const admin = createAdminClient();

let judoClubId: string;
let taekwondoClubId: string;
test.beforeAll(async () => {
  const { data: judo, error: judoError } = await admin.from("club").select("id").eq("slug", "judo").single();
  if (judoError) throw judoError;
  judoClubId = judo.id;
  const { data: taekwondo, error: tkdError } = await admin.from("club").select("id").eq("slug", "taekwondo").single();
  if (tkdError) throw tkdError;
  taekwondoClubId = taekwondo.id;
});

test.describe("listActiveDebtCycles is scoped by club", () => {
  let personIds: string[] = [];
  let sessionIds: string[] = [];

  test.afterEach(async () => {
    if (sessionIds.length) {
      await admin.from("attendance_record").delete().in("session_id", sessionIds);
      await admin.from("session").delete().in("id", sessionIds);
      sessionIds = [];
    }
    if (personIds.length) {
      await admin.from("person").delete().in("id", personIds);
      personIds = [];
    }
  });

  test("a Taekwondo debtor never appears in a Judo-scoped call", async () => {
    const { data: tkdPerson, error } = await admin
      .from("person")
      .insert({ club_id: taekwondoClubId, full_name: "Taekwondo Debtor", email: `tkd-debt-${crypto.randomUUID()}@example.test` })
      .select("id")
      .single();
    if (error) throw error;
    personIds.push(tkdPerson!.id);

    for (const daysAgo of [20, 10]) {
      const { data: session, error: sessionError } = await admin
        .from("session")
        .insert({ club_id: taekwondoClubId, title: "Taekwondo Debt Test Session", starts_at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString() })
        .select("id")
        .single();
      if (sessionError) throw sessionError;
      sessionIds.push(session!.id);
      const { error: attendanceError } = await admin
        .from("attendance_record")
        .insert({ club_id: taekwondoClubId, person_id: tkdPerson!.id, session_id: session!.id, source: "manual_tick" });
      if (attendanceError) throw attendanceError;
    }

    const judoResults = await listActiveDebtCycles(judoClubId);
    expect(judoResults.some((c) => c.personId === tkdPerson!.id)).toBe(false);

    const taekwondoResults = await listActiveDebtCycles(taekwondoClubId);
    expect(taekwondoResults.some((c) => c.personId === tkdPerson!.id)).toBe(true);
  });
});

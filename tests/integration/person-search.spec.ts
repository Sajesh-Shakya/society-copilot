import { test, expect } from "@playwright/test";
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

interface SearchRow {
  id: string;
  full_name: string;
  email: string;
  cid: string | null;
  similarity: number;
}

async function search(query: string): Promise<SearchRow[]> {
  const { data, error } = await admin.rpc("search_person_by_name", { search_query: query });
  if (error) throw error;
  return data as SearchRow[];
}

async function createPerson(fullName: string, email: string) {
  const { data, error } = await admin
    .from("person")
    .insert({ full_name: fullName, email, is_exempt: false })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test.describe("search_person_by_name with email matching", () => {
  let personIds: string[] = [];

  test.afterEach(async () => {
    if (personIds.length === 0) return;
    const { error } = await admin.from("person").delete().in("id", personIds);
    if (error) throw error;
    personIds = [];
  });

  test("still matches on fuzzy name similarity (existing behavior)", async () => {
    const id = await createPerson("Jonathan Smithe", `search-test-${crypto.randomUUID()}@example.test`);
    personIds.push(id);

    const results = await search("Jonathan Smith");
    expect(results.some((r) => r.id === id)).toBe(true);
  });

  test("matches on an email substring even when the name is completely different", async () => {
    const uniqueLocalPart = `zqx-${crypto.randomUUID()}`;
    const email = `${uniqueLocalPart}@example.test`;
    const id = await createPerson("Completely Unrelated Name", email);
    personIds.push(id);

    const results = await search(uniqueLocalPart);
    expect(results.some((r) => r.id === id)).toBe(true);
  });

  test("an email substring match ranks above a fuzzy name match", async () => {
    const sharedToken = `rankcheck${crypto.randomUUID().replace(/-/g, "")}`;
    // Email match: the token appears in the email, name is unrelated.
    const emailMatchId = await createPerson("Zzz Unrelated", `${sharedToken}@example.test`);
    // Name match: the token appears in the name (imperfect fuzzy match), email is unrelated.
    const nameMatchId = await createPerson(sharedToken, `other-${crypto.randomUUID()}@example.test`);
    personIds.push(emailMatchId, nameMatchId);

    const results = await search(sharedToken);
    const emailMatchIndex = results.findIndex((r) => r.id === emailMatchId);
    const nameMatchIndex = results.findIndex((r) => r.id === nameMatchId);
    expect(emailMatchIndex).toBeGreaterThanOrEqual(0);
    expect(nameMatchIndex).toBeGreaterThanOrEqual(0);
    expect(emailMatchIndex).toBeLessThan(nameMatchIndex);
  });

  test("does not match an unrelated person", async () => {
    const id = await createPerson("Totally Unrelated Person", `unrelated-${crypto.randomUUID()}@example.test`);
    personIds.push(id);

    const results = await search(`nonexistent-query-${crypto.randomUUID()}`);
    expect(results.some((r) => r.id === id)).toBe(false);
  });
});

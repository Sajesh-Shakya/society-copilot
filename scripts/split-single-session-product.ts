// SUPERSEDED (2026-11-22): judo ended up with "Single Session Pass" as the £5
// member product, so do NOT re-run this for judo (it would recreate "(Member)").
// One-off: split "Single Session Pass" into Member (sales id 2922, £5) and
// Non-member (sales id 2880, £8) products, re-pointing the uploads whose
// filename contains Product_Sales_ID_<id>. Dry-run by default.
//
// Usage: npx tsx scripts/split-single-session-product.ts --club judo [--apply]
//
// Idempotent: a second run reports "nothing to do".

import { config } from "dotenv";

config({ path: ".env.local" });

const OLD_NAME = "Single Session Pass";
const TARGETS = [
  { name: "Single Session Pass (Member)", salesId: "2922", pricePence: 500 },
  { name: "Single Session Pass (Non-member)", salesId: "2880", pricePence: 800 },
] as const;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const slug = arg("--club");
  const apply = process.argv.includes("--apply");
  if (!slug) throw new Error("Usage: --club <slug> [--apply]");

  // Dynamic imports: env must be loaded before the Supabase clients are built.
  const { createAdminClient } = await import("../lib/supabase/admin");
  const { createClubScopedClient } = await import("../lib/supabase/club-scoped");
  const { changeUploadProduct } = await import("../lib/purchase/interface");
  const { createProduct, applyPriceToUnpricedPurchases, updateProduct } = await import("../lib/products/writer");

  const admin = createAdminClient();
  const { data: club, error: clubError } = await admin.from("club").select("id").eq("slug", slug).single();
  if (clubError) throw clubError;
  const clubId = club.id as string;
  const scoped = createClubScopedClient(clubId);

  const { data: products, error: pErr } = await scoped.from("product").select("id, name, active, price_pence, external_sales_id");
  if (pErr) throw pErr;
  const byName = new Map((products as unknown as { id: string; name: string; active: boolean }[]).map((p) => [p.name, p]));
  const oldProduct = byName.get(OLD_NAME);

  const { data: uploads, error: uErr } = await scoped
    .from("purchase_upload")
    .select("id, product_id, filename, row_count");
  if (uErr) throw uErr;
  const allUploads = uploads as unknown as { id: string; product_id: string; filename: string | null; row_count: number }[];

  console.log(`Club: ${slug} (${clubId}) -- ${apply ? "APPLY" : "DRY RUN"}`);
  let work = 0;
  const plan: { target: (typeof TARGETS)[number]; existingId: string | undefined; uploadIds: string[]; purchases: number }[] = [];

  for (const target of TARGETS) {
    const existing = byName.get(target.name);
    const matching = allUploads.filter(
      (u) => u.filename && new RegExp(`Product_Sales_ID_${target.salesId}(?!\\d)`, "i").test(u.filename) && u.product_id !== existing?.id
    );
    let purchases = 0;
    for (const u of matching) {
      const { count, error } = await scoped.from("purchase").select("id", { count: "exact", head: true }).eq("upload_id", u.id);
      if (error) throw error;
      purchases += count ?? 0;
    }
    plan.push({ target, existingId: existing?.id, uploadIds: matching.map((u) => u.id), purchases });
    console.log(
      `- ${target.name}: ${existing ? "exists" : "will be created"} (price £${(target.pricePence / 100).toFixed(2)}, sales id ${target.salesId}); ` +
        `${matching.length} upload(s) to re-point, ${purchases} purchase(s)`
    );
    for (const u of matching) console.log(`    upload ${u.id}  ${u.filename}  rows=${u.row_count}`);
    if (!existing || matching.length > 0) work++;
  }

  let oldRemaining = 0;
  if (oldProduct) {
    const { count } = await scoped.from("purchase").select("id", { count: "exact", head: true }).eq("product_id", oldProduct.id);
    oldRemaining = count ?? 0;
    console.log(`- Old "${OLD_NAME}": ${oldRemaining} purchase(s) currently reference it; active=${oldProduct.active}`);
  } else {
    console.log(`- Old "${OLD_NAME}" not found.`);
  }

  if (work === 0 && !(oldProduct && oldProduct.active && oldRemaining === 0)) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to make these changes.");
    return;
  }

  for (const step of plan) {
    let id = step.existingId;
    if (!id) {
      const res = await createProduct(clubId, {
        name: step.target.name,
        kind: "session_pass",
        coversSessions: 1,
        pricePence: step.target.pricePence,
        externalSalesId: step.target.salesId,
      });
      if ("error" in res) throw new Error(res.error);
      id = res.id;
      console.log(`Created ${step.target.name}`);
    }
    for (const uploadId of step.uploadIds) {
      const r = await changeUploadProduct(clubId, uploadId, id);
      console.log(`Re-pointed upload ${uploadId}: ${r.purchasesUpdated} purchases, ${r.rewaived} re-waived`);
    }
    const applied = await applyPriceToUnpricedPurchases(clubId, id);
    console.log(`Priced ${step.target.name}: ${JSON.stringify(applied)}`);
  }

  if (oldProduct) {
    const { count } = await scoped.from("purchase").select("id", { count: "exact", head: true }).eq("product_id", oldProduct.id);
    if ((count ?? 0) === 0) {
      const r = await updateProduct(clubId, oldProduct.id, { active: false });
      console.log(`Retired old product: ${JSON.stringify(r)}`);
    } else {
      console.log(`Old product still has ${count} purchase(s); left active.`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

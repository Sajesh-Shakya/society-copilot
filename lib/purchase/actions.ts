"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { rematchUnmatchedPurchases as rematchUnmatchedPurchasesImpl } from "./interface";

export async function rematchUnmatchedPurchases() {
  await requireAdmin();
  return rematchUnmatchedPurchasesImpl();
}

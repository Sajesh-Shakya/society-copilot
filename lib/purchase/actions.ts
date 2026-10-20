"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  rematchUnmatchedPurchases as rematchUnmatchedPurchasesImpl,
  changeUploadProduct as changeUploadProductImpl,
  undoUpload as undoUploadImpl,
} from "./interface";

export async function rematchUnmatchedPurchases() {
  await requireAdmin();
  return rematchUnmatchedPurchasesImpl();
}

const idSchema = z.string().uuid();

export async function changeUploadProduct(uploadId: string, newProductId: string) {
  await requireAdmin();
  const parsedUploadId = idSchema.parse(uploadId);
  const parsedProductId = idSchema.parse(newProductId);
  return changeUploadProductImpl(parsedUploadId, parsedProductId);
}

export async function undoUpload(uploadId: string) {
  await requireAdmin();
  const parsedUploadId = idSchema.parse(uploadId);
  return undoUploadImpl(parsedUploadId);
}

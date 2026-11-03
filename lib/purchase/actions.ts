"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  rematchUnmatchedPurchases as rematchUnmatchedPurchasesImpl,
  changeUploadProduct as changeUploadProductImpl,
  undoUpload as undoUploadImpl,
} from "./interface";

export async function rematchUnmatchedPurchases(clubSlug: string) {
  const { clubId } = await requireAdmin(clubSlug);
  return rematchUnmatchedPurchasesImpl(clubId);
}

const idSchema = z.string().uuid();

export async function changeUploadProduct(clubSlug: string, uploadId: string, newProductId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  const parsedUploadId = idSchema.parse(uploadId);
  const parsedProductId = idSchema.parse(newProductId);
  return changeUploadProductImpl(clubId, parsedUploadId, parsedProductId);
}

export async function undoUpload(clubSlug: string, uploadId: string) {
  const { clubId } = await requireAdmin(clubSlug);
  const parsedUploadId = idSchema.parse(uploadId);
  return undoUploadImpl(clubId, parsedUploadId);
}

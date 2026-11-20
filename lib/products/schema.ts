import { z } from "zod";

export const productKindSchema = z.enum(["session_pass", "term_pass", "annual_pass", "other"]);

export const productInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
    kind: productKindSchema,
    coversSessions: z.number().int().min(1, "Sessions covered must be at least 1").nullable(),
    pricePence: z.number().int().min(0, "Price cannot be negative").nullable(),
    externalSalesId: z.string().trim().min(1).nullable(),
  })
  .refine((v) => v.kind !== "session_pass" || v.coversSessions !== null, {
    message: "Session passes must say how many sessions they cover",
    path: ["coversSessions"],
  });

export type ProductInput = z.infer<typeof productInputSchema>;

export const productPatchSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long").optional(),
  pricePence: z.number().int().min(0, "Price cannot be negative").nullable().optional(),
  active: z.boolean().optional(),
  externalSalesId: z.string().trim().min(1).nullable().optional(),
});

export type ProductPatch = z.infer<typeof productPatchSchema>;

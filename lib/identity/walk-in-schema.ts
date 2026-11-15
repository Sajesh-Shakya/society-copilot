import { z } from "zod";
import { normalizeCid } from "@/lib/utils";

export const CID_ERROR = "CID is 8 digits, or 7 if you leave off the leading 0";
export const NAME_ERROR = "Enter first name and surname";

const cidField = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{7,8}$/.test(v), { message: CID_ERROR })
  .transform((v) => (v === "" ? undefined : normalizeCid(v)))
  .optional();

const fullNameField = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, " "))
  .refine(
    (v) => {
      const words = v.split(" ").filter(Boolean);
      return words.length >= 2 && words.every((w) => /\p{L}/u.test(w));
    },
    { message: NAME_ERROR },
  );

export const walkInSchema = z.object({
  sessionId: z.string().uuid(),
  email: z.string().trim().email(),
  fullName: fullNameField,
  cid: cidField,
});

export type WalkInInput = z.infer<typeof walkInSchema>;

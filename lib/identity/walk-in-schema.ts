import { z } from "zod";
import { normalizeCid } from "@/lib/utils";

export const CID_ERROR = "CID is 8 digits, or 7 if you leave off the leading 0";
export const NAME_ERROR = "Enter first name and surname";
export const EMAIL_ERROR = "Enter a valid email address";
export const NAME_TOO_LONG_ERROR = "Name is too long";
export const EMAIL_TOO_LONG_ERROR = "Email is too long";
/** Checked after whitespace is collapsed. */
export const NAME_MAX = 200;
/** RFC 5321 path limit. */
export const EMAIL_MAX = 254;

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
  )
  .refine((v) => v.length <= NAME_MAX, { message: NAME_TOO_LONG_ERROR });

export const walkInSchema = z.object({
  sessionId: z.string().uuid(),
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX, { message: EMAIL_TOO_LONG_ERROR })
    .email({ message: EMAIL_ERROR }),
  fullName: fullNameField,
  cid: cidField,
});

export type WalkInInput = z.infer<typeof walkInSchema>;

/** The form's fields only (the form already knows the session). */
const walkInFieldsSchema = walkInSchema.omit({ sessionId: true });

export type WalkInFieldErrors = Partial<Record<"email" | "fullName" | "cid", string>>;

/**
 * Field-level check for the walk-in form, using the same schema the server
 * action parses with, so the messages cannot drift. Returns the first message
 * per invalid field; `{}` means valid.
 */
export function validateWalkInFields(fields: { email: string; fullName: string; cid: string }): WalkInFieldErrors {
  const result = walkInFieldsSchema.safeParse(fields);
  if (result.success) return {};
  const errors: WalkInFieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if ((key === "email" || key === "fullName" || key === "cid") && !errors[key]) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

/** The message to show for a failed `walkInSchema` parse. */
export function firstWalkInError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the walk-in details";
}

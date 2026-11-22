import { z } from "zod";

const targetsSchema = z
  .object({
    signupTarget: z.number().int("Target must be a whole number").min(0, "Target cannot be negative"),
    signupMin: z.number().int("Minimum must be a whole number").min(0, "Minimum cannot be negative"),
  })
  .refine((v) => v.signupMin <= v.signupTarget, { message: "Minimum cannot be above the target" });

export type Targets = z.infer<typeof targetsSchema>;

export function validateTargets(input: unknown): Targets | { error: string } {
  const parsed = targetsSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  return parsed.data;
}

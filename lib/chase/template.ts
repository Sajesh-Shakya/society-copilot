// Deterministic chase-email content -- no LLM involved. Kept as a pure
// function (no I/O) so it's unit-testable without a live database.
export function buildChaseEmailContent(input: {
  fullName: string;
  debtCount: number;
}): { subject: string; body: string } {
  const { fullName, debtCount } = input;
  const sessionWord = debtCount === 1 ? "session" : "sessions";

  const subject = `Payment reminder: ${debtCount} unpaid ${sessionWord}`;

  const body = [
    `Hi ${fullName},`,
    "",
    `Our records show you have ${debtCount} unpaid ${sessionWord} outstanding.`,
    "Please arrange payment at your earliest convenience, or get in touch if you think this is a mistake.",
    "",
    "Thanks,",
    "The committee",
  ].join("\n");

  return { subject, body };
}

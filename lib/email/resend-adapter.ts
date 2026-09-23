import type { EmailChannelAdapter } from "./types";

const RESEND_API_URL = "https://api.resend.com/emails";
// Fixed regardless of provider -- see design.md's "Decisions already made".
// There is currently exactly one reply destination for this product.
const REPLY_TO = "judo@ic.ac.uk";

export class ResendNotConfiguredError extends Error {
  constructor(missingVar: string) {
    super(`${missingVar} is not set -- cannot send email via Resend.`);
    this.name = "ResendNotConfiguredError";
  }
}

export class ResendApiError extends Error {
  constructor(status: number, body: string) {
    super(`Resend API returned ${status}: ${body}`);
    this.name = "ResendApiError";
  }
}

/**
 * Thin fetch wrapper for Resend's send-email endpoint -- follows this
 * repo's existing convention (see lib/eactivities/client.ts) rather than
 * adding an SDK dependency. Deliberately has NO retry logic: the caller
 * (lib/chase/send.ts) owns failure handling, recording a `failed` status
 * for a human to act on rather than retrying automatically -- see
 * design.md's "Failure handling" decision.
 */
export class ResendEmailAdapter implements EmailChannelAdapter {
  async send(input: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }> {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw new ResendNotConfiguredError("RESEND_API_KEY");
    const from = process.env.CHASE_FROM_EMAIL;
    if (!from) throw new ResendNotConfiguredError("CHASE_FROM_EMAIL");

    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: input.to,
        reply_to: REPLY_TO,
        subject: input.subject,
        text: input.body,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw new ResendApiError(response.status, bodyText);
    }

    const data = (await response.json()) as { id: string };
    return { providerMessageId: data.id };
  }
}

export const resendEmailAdapter = new ResendEmailAdapter();

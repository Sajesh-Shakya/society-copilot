import { test, expect } from "@playwright/test";
import {
  ResendEmailAdapter,
  ResendApiError,
  ResendNotConfiguredError,
} from "@/lib/email/resend-adapter";

test.describe("ResendEmailAdapter", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.RESEND_API_KEY;
  const originalFrom = process.env.CHASE_FROM_EMAIL;

  test.afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalApiKey;
    if (originalFrom === undefined) delete process.env.CHASE_FROM_EMAIL;
    else process.env.CHASE_FROM_EMAIL = originalFrom;
  });

  test("sends and returns the provider message id", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.CHASE_FROM_EMAIL = "payments@mail.example.test";

    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({ id: "msg_123" }), { status: 200 });
    }) as typeof fetch;

    const adapter = new ResendEmailAdapter();
    const result = await adapter.send({
      to: "member@example.test",
      subject: "Payment reminder",
      body: "Hi there",
      idempotencyKey: "chase-email-id-1",
    });

    expect(result.providerMessageId).toBe("msg_123");
    expect(capturedUrl).toBe("https://api.resend.com/emails");

    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("chase-email-id-1");
    expect(headers["Authorization"]).toBe("Bearer test-key");

    const payload = JSON.parse(capturedInit.body as string);
    expect(payload.from).toBe("payments@mail.example.test");
    expect(payload.reply_to).toBe("judo@ic.ac.uk");
    expect(payload.to).toBe("member@example.test");
    expect(payload.subject).toBe("Payment reminder");
    expect(payload.text).toBe("Hi there");
  });

  test("throws ResendNotConfiguredError when RESEND_API_KEY is missing", async () => {
    delete process.env.RESEND_API_KEY;
    process.env.CHASE_FROM_EMAIL = "payments@mail.example.test";

    const adapter = new ResendEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.test", subject: "s", body: "b", idempotencyKey: "k" })
    ).rejects.toThrow(ResendNotConfiguredError);
  });

  test("throws ResendNotConfiguredError when CHASE_FROM_EMAIL is missing", async () => {
    process.env.RESEND_API_KEY = "test-key";
    delete process.env.CHASE_FROM_EMAIL;

    const adapter = new ResendEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.test", subject: "s", body: "b", idempotencyKey: "k" })
    ).rejects.toThrow(ResendNotConfiguredError);
  });

  test("throws ResendApiError when Resend returns a non-2xx response", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.CHASE_FROM_EMAIL = "payments@mail.example.test";
    globalThis.fetch = (async () => new Response("bad request", { status: 422 })) as typeof fetch;

    const adapter = new ResendEmailAdapter();
    await expect(
      adapter.send({ to: "a@example.test", subject: "s", body: "b", idempotencyKey: "k" })
    ).rejects.toThrow(ResendApiError);
  });
});

// The internal port every outbound-email caller depends on -- see
// core/INTEGRATIONS.md's "Channel adapters" layer. Never import a specific
// provider (Resend, etc.) outside of its own adapter file.
export interface EmailChannelAdapter {
  send(input: {
    to: string;
    subject: string;
    body: string;
    // Passed straight through to the provider's idempotency mechanism.
    // Callers should pass a value that's stable across retries of the
    // same logical send (e.g. a chase_email row's id) so a retry after a
    // failed status-write can't produce a real duplicate email.
    idempotencyKey: string;
  }): Promise<{ providerMessageId: string }>;
}

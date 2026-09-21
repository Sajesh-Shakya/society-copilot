import { test, expect } from "@playwright/test";
import { buildChaseEmailContent } from "@/lib/chase/template";

test.describe("buildChaseEmailContent", () => {
  test("singular wording for exactly 1 unpaid session", () => {
    const { subject, body } = buildChaseEmailContent({ fullName: "Ada Lovelace", debtCount: 1 });
    expect(subject).toBe("Payment reminder: 1 unpaid session");
    expect(body).toContain("Hi Ada Lovelace,");
    expect(body).toContain("1 unpaid session outstanding");
    expect(body).not.toContain("sessions outstanding");
  });

  test("plural wording for more than 1 unpaid session", () => {
    const { subject, body } = buildChaseEmailContent({ fullName: "Grace Hopper", debtCount: 3 });
    expect(subject).toBe("Payment reminder: 3 unpaid sessions");
    expect(body).toContain("3 unpaid sessions outstanding");
  });

  test("does not throw or produce empty content for 0 (defensive -- callers should never pass 0)", () => {
    const { subject, body } = buildChaseEmailContent({ fullName: "Zero Debt", debtCount: 0 });
    expect(subject.length).toBeGreaterThan(0);
    expect(body.length).toBeGreaterThan(0);
  });
});

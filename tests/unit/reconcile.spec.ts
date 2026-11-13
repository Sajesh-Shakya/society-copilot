import { test, expect } from "@playwright/test";
import { reconcileRows } from "@/lib/attendance/reconcile";
import type { AttendanceRow } from "@/lib/attendance/queries";

const row = (personId: string, attended: boolean) =>
  ({ personId, fullName: personId, email: `${personId}@x.test`, attended }) as AttendanceRow;

test.describe("reconcileRows", () => {
  test("returns fresh rows when nothing is pending", () => {
    const fresh = [row("a", true), row("b", false)];
    expect(reconcileRows(fresh, new Map())).toEqual(fresh);
  });

  test("keeps the optimistic value for in-flight toggles", () => {
    const fresh = [row("a", false), row("b", true)];
    const out = reconcileRows(fresh, new Map([["a", true]]));
    expect(out.map((r) => r.attended)).toEqual([true, true]);
  });

  test("takes server state for rows not pending", () => {
    const out = reconcileRows([row("a", true)], new Map([["zzz", false]]));
    expect(out[0].attended).toBe(true);
  });
});

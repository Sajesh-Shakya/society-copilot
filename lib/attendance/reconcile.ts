import type { AttendanceRow } from "@/lib/attendance/queries";

// Merge a freshly fetched roster into local state without clobbering
// optimistic toggles that haven't been confirmed by the server yet.
// `pending` maps personId -> the attended value the user just set.
export function reconcileRows(
  fresh: AttendanceRow[],
  pending: ReadonlyMap<string, boolean>
): AttendanceRow[] {
  if (pending.size === 0) return fresh;
  return fresh.map((row) =>
    pending.has(row.personId) ? { ...row, attended: pending.get(row.personId)! } : row
  );
}

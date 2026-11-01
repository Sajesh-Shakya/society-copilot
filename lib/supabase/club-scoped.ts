import { createAdminClient } from "@/lib/supabase/admin";

const CLUB_SCOPED_TABLES = [
  "person",
  "session",
  "product",
  "purchase",
  "purchase_upload",
  "attendance_record",
  "chase_email",
  "sync_cursor",
  "outstanding_attendance",
  "active_debt_cycle",
] as const;
type ClubScopedTable = (typeof CLUB_SCOPED_TABLES)[number];

// RPCs that read/write across the whole table and need the club baked into
// their own SQL (a post-hoc .eq() on the result can't scope a function that
// already LIMITs internally, or that writes as a side effect) -- see
// docs/superpowers/specs/2026-11-01-multi-tenancy-plan2-design.md's Migration
// C/D. Row-scoped RPCs (toggle_attendance, apply_purchase_waiver,
// reapply_waivers_for_person, person_outstanding_debt) are NOT in this list
// -- they pass through unchanged, relying on the caller having already
// verified the row belongs to this club.
const CLUB_AWARE_RPC_PARAM: Record<string, string> = {
  search_person_by_name: "target_club_id",
  reapply_waivers_for_everyone_with_debt: "target_club_id",
};

type Row = Record<string, unknown>;

function assertSameClubOrUnset(row: Row, clubId: string, table: string, verb: string) {
  if ("club_id" in row && row.club_id !== clubId) {
    throw new Error(`createClubScopedClient: ${verb} on "${table}" specified a different club_id`);
  }
}

export function createClubScopedClient(clubId: string) {
  const client = createAdminClient();

  return {
    clubId,
    from(table: ClubScopedTable) {
      const base = client.from(table);
      return {
        select: (
          columns = "*",
          opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }
        ) => base.select(columns, opts).eq("club_id", clubId),

        insert: (values: Row | Row[]) => {
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) assertSameClubOrUnset(row, clubId, table, "insert");
          const stamped = rows.map((row) => ({ ...row, club_id: clubId }));
          return base.insert(Array.isArray(values) ? stamped : stamped[0]);
        },

        upsert: (
          values: Row | Row[],
          opts?: { onConflict?: string; ignoreDuplicates?: boolean }
        ) => {
          if (opts?.onConflict && !opts.ignoreDuplicates) {
            const conflictColumns = opts.onConflict.split(",").map((c) => c.trim());
            if (!conflictColumns.includes("club_id")) {
              throw new Error(
                `createClubScopedClient: upsert on "${table}" has onConflict "${opts.onConflict}" ` +
                  `that doesn't include "club_id" -- a DO UPDATE on that conflict target could silently ` +
                  `overwrite a row belonging to a different club. Include "club_id" in onConflict, or ` +
                  `pass ignoreDuplicates: true if an insert-only upsert is intended.`
              );
            }
          }
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) assertSameClubOrUnset(row, clubId, table, "upsert");
          const stamped = rows.map((row) => ({ ...row, club_id: clubId }));
          return base.upsert(Array.isArray(values) ? stamped : stamped[0], opts);
        },

        update: (values: Row) => {
          if ("club_id" in values) {
            throw new Error(`createClubScopedClient: update on "${table}" may not change club_id`);
          }
          return base.update(values).eq("club_id", clubId);
        },

        delete: () => base.delete().eq("club_id", clubId),
      };
    },

    rpc(name: string, args: Row = {}) {
      const clubArgName = CLUB_AWARE_RPC_PARAM[name];
      return client.rpc(name, clubArgName ? { ...args, [clubArgName]: clubId } : args);
    },
  };
}

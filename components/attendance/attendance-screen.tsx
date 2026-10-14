"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";
import {
  toggleAttendance,
  triggerManualSync,
  getAttendanceList,
  setSessionCancelled,
} from "@/lib/attendance/actions";
import { fuzzyMatches } from "@/lib/attendance/fuzzy-match";
import type { AttendanceRow, SessionWithAttendance } from "@/lib/attendance/queries";
import { AddAttendee } from "@/components/attendance/add-attendee";
import { SyncCsvButton } from "@/components/attendance/sync-csv-button";
import { SignOutButton } from "@/components/auth/sign-out-button";

// Prefer an exact (substring) match on the name; only fall back to
// typo-tolerant fuzzy matching when nothing matches exactly. A lenient
// fuzzy match against every name was turning up unrelated people whenever
// a real, exact match already existed.
function findMatches(query: string, rows: AttendanceRow[]): AttendanceRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = rows.filter((r) => r.fullName.toLowerCase().includes(q));
  if (exact.length > 0) return exact;
  return rows.filter((r) => fuzzyMatches(query, r.fullName));
}

export function AttendanceScreen({ session }: { session: SessionWithAttendance }) {
  const [rows, setRows] = useState<AttendanceRow[]>(session.attendance);
  const [isSyncing, startSync] = useTransition();
  const [showEmails, setShowEmails] = useState(false);
  const [search, setSearch] = useState("");
  const [cancelledAt, setCancelledAt] = useState<string | null>(session.cancelledAt);
  const [isTogglingCancel, startCancelToggle] = useTransition();

  // AC-3: propagate toggle changes to every open attendance screen for this
  // session within 2s. UPDATE payloads carry attended directly, so patch
  // state immediately. INSERT payloads only carry attendance_record's own
  // columns (person_id) — no joined person name/email — so a genuinely new
  // row triggers a refetch instead of trying to render partial data.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`attendance:${session.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "attendance_record",
          filter: `session_id=eq.${session.id}`,
        },
        async (payload) => {
          if (payload.eventType === "UPDATE") {
            const updated = payload.new as { person_id: string; attended: boolean };
            setRows((prev) =>
              prev.map((row) =>
                row.personId === updated.person_id
                  ? { ...row, attended: updated.attended }
                  : row
              )
            );
          } else if (payload.eventType === "INSERT" || payload.eventType === "DELETE") {
            const fresh = await getAttendanceList(session.id);
            setRows(fresh);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session.id]);

  function handleToggle(row: AttendanceRow, attended: boolean) {
    setRows((prev) =>
      prev.map((r) => (r.personId === row.personId ? { ...r, attended } : r))
    );
    toggleAttendance({ sessionId: session.id, personId: row.personId, attended }).catch(
      () => {
        toast.error(`Couldn't update ${row.fullName}`);
        setRows((prev) =>
          prev.map((r) => (r.personId === row.personId ? { ...r, attended: !attended } : r))
        );
      }
    );
  }

  function handleSync() {
    startSync(async () => {
      try {
        await triggerManualSync(session.id);
        const fresh = await getAttendanceList(session.id);
        setRows(fresh);
        toast.success("Synced with eActivities");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Sync failed");
      }
    });
  }

  function handleToggleCancel() {
    const next = !cancelledAt;
    startCancelToggle(async () => {
      try {
        await setSessionCancelled({ sessionId: session.id, cancelled: next });
        setCancelledAt(next ? new Date().toISOString() : null);
        toast.success(next ? "Session cancelled" : "Session un-cancelled");
      } catch {
        toast.error("Couldn't update cancellation status");
      }
    });
  }

  async function refetchRows() {
    const fresh = await getAttendanceList(session.id);
    setRows(fresh);
  }

  const trimmedSearch = search.trim();
  const searchResults = trimmedSearch ? findMatches(trimmedSearch, rows) : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/sessions" className="text-sm text-muted-foreground underline">
          ← All sessions
        </Link>
      </div>

      {cancelledAt && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          This session is cancelled.
        </div>
      )}

      <div className="flex flex-col items-start gap-4 sm:flex-row sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{session.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {new Date(session.startsAt).toLocaleString()}
            {session.lastSyncedAt && (
              <> · last synced {new Date(session.lastSyncedAt).toLocaleTimeString()}</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowEmails((v) => !v)}>
            {showEmails ? "Hide emails" : "Show emails"}
          </Button>
          {session.eactivitiesSignupId !== null && (
            <Button variant="outline" onClick={handleSync} disabled={isSyncing}>
              {isSyncing ? "Syncing…" : "Sync now"}
            </Button>
          )}
          <Button
            variant={cancelledAt ? "outline" : "destructive"}
            size="sm"
            onClick={handleToggleCancel}
            disabled={isTogglingCancel}
          >
            {cancelledAt ? "Un-cancel session" : "Cancel session"}
          </Button>
          <SignOutButton />
        </div>
      </div>

      {rows.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find someone on this roster (typo-tolerant)…"
          />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No one on the roster yet — try syncing, or add someone below.
        </p>
      ) : trimmedSearch ? (
        <AttendanceGroup
          title={`Search results`}
          rows={searchResults}
          showEmails={showEmails}
          onToggle={handleToggle}
          emptyMessage="No matches."
        />
      ) : (
        <>
          <AttendanceGroup
            title="Not attended"
            rows={rows.filter((r) => !r.attended)}
            showEmails={showEmails}
            onToggle={handleToggle}
            scrollable
          />
          <AttendanceGroup
            title="Attended"
            rows={rows.filter((r) => r.attended)}
            showEmails={showEmails}
            onToggle={handleToggle}
            scrollable
          />
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <AddAttendee
          sessionId={session.id}
          existingPersonIds={rows.map((r) => r.personId)}
          onAdded={(row) => setRows((prev) => [...prev, row].sort((a, b) => a.fullName.localeCompare(b.fullName)))}
        />
        <SyncCsvButton sessionId={session.id} onSynced={refetchRows} />
      </div>
    </div>
  );
}

function AttendanceGroup({
  title,
  rows,
  showEmails,
  onToggle,
  scrollable = false,
  emptyMessage = "None.",
}: {
  title: string;
  rows: AttendanceRow[];
  showEmails: boolean;
  onToggle: (row: AttendanceRow, attended: boolean) => void;
  scrollable?: boolean;
  emptyMessage?: string;
}) {
  const table = (
    <Table>
      <TableHeader>
        <TableRow className="border-b-2 border-border">
          <TableHead className={scrollable ? "sticky top-0 z-10 w-10 bg-background" : "w-10"}></TableHead>
          <TableHead className={scrollable ? "sticky top-0 z-10 bg-background" : undefined}>
            Name
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.personId} className="border-b-2 border-border">
            <TableCell>
              <Checkbox
                checked={row.attended}
                onCheckedChange={(checked) => onToggle(row, checked === true)}
                aria-label={`Mark ${row.fullName} ${row.attended ? "not attended" : "attended"}`}
                className="border-2 border-foreground/60"
              />
            </TableCell>
            <TableCell className={row.attended ? "" : "text-muted-foreground"}>
              <div>{row.fullName}</div>
              {showEmails && <div className="text-xs text-muted-foreground">{row.email}</div>}
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={2} className="py-4 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );

  return (
    <div>
      <h2 className="text-sm font-semibold text-muted-foreground">
        {title} ({rows.length})
      </h2>
      {scrollable ? (
        <div className="mt-2 max-h-80 overflow-y-auto rounded-md border-2 border-border">
          {table}
        </div>
      ) : (
        <div className="mt-2">{table}</div>
      )}
    </div>
  );
}

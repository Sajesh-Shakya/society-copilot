"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "@/lib/attendance/actions";
import type { AttendanceRow, SessionWithAttendance } from "@/lib/attendance/queries";
import { AddAttendee } from "@/components/attendance/add-attendee";
import { SignOutButton } from "@/components/auth/sign-out-button";

const SOURCE_LABEL: Record<AttendanceRow["source"], string> = {
  signup_sync: "eActivities",
  manual_tick: "Added",
  walk_in: "Walk-in",
};

export function AttendanceScreen({ session }: { session: SessionWithAttendance }) {
  const [rows, setRows] = useState<AttendanceRow[]>(session.attendance);
  const [isSyncing, startSync] = useTransition();
  const [showEmails, setShowEmails] = useState(false);

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{session.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {new Date(session.startsAt).toLocaleString()}
            {session.lastSyncedAt && (
              <> · last synced {new Date(session.lastSyncedAt).toLocaleTimeString()}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowEmails((v) => !v)}>
            {showEmails ? "Hide emails" : "Show emails"}
          </Button>
          <Button variant="outline" onClick={handleSync} disabled={isSyncing}>
            {isSyncing ? "Syncing…" : "Sync now"}
          </Button>
          <SignOutButton />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No one on the roster yet — try syncing, or add someone below.
        </p>
      ) : (
        <>
          <AttendanceGroup
            title="Attended"
            rows={rows.filter((r) => r.attended)}
            showEmails={showEmails}
            onToggle={handleToggle}
          />
          <AttendanceGroup
            title="Not attended"
            rows={rows.filter((r) => !r.attended)}
            showEmails={showEmails}
            onToggle={handleToggle}
          />
        </>
      )}

      <AddAttendee
        sessionId={session.id}
        existingPersonIds={rows.map((r) => r.personId)}
        onAdded={(row) => setRows((prev) => [...prev, row].sort((a, b) => a.fullName.localeCompare(b.fullName)))}
      />
    </div>
  );
}

function AttendanceGroup({
  title,
  rows,
  showEmails,
  onToggle,
}: {
  title: string;
  rows: AttendanceRow[];
  showEmails: boolean;
  onToggle: (row: AttendanceRow, attended: boolean) => void;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-muted-foreground">
        {title} ({rows.length})
      </h2>
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead className="w-10"></TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.personId}>
              <TableCell>
                <Checkbox
                  checked={row.attended}
                  onCheckedChange={(checked) => onToggle(row, checked === true)}
                  aria-label={`Mark ${row.fullName} ${row.attended ? "not attended" : "attended"}`}
                />
              </TableCell>
              <TableCell className={row.attended ? "" : "text-muted-foreground"}>
                <div>{row.fullName}</div>
                {showEmails && <div className="text-xs text-muted-foreground">{row.email}</div>}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{SOURCE_LABEL[row.source]}</Badge>
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="py-4 text-center text-sm text-muted-foreground">
                None.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { clubPath } from "@/lib/club-path";
import { deleteSeriesFromAction, previewSeriesDeleteAction } from "@/lib/session-series/actions";
import type { SeriesDeletePlan } from "@/lib/session-series/delete";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function summary(plan: SeriesDeletePlan): string {
  const deleting = plural(plan.toDelete.length, "event will be deleted", "events will be deleted");
  if (plan.kept.length === 0) return deleting;
  return `${deleting}, ${plan.kept.length} kept because ${plan.kept.length === 1 ? "it has" : "they have"} attendance`;
}

/**
 * Inline confirmation for "Delete this and all later events". Shows the server
 * preview first; nothing is deleted until the explicit confirm click. After a
 * successful delete the panel stays locked while navigating to the sessions list.
 */
export function SeriesDeletePanel({ sessionId, clubSlug }: { sessionId: string; clubSlug: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<SeriesDeletePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleOpen() {
    setOpen(true);
    setError(null);
    setPlan(null);
    startTransition(async () => {
      try {
        const result = await previewSeriesDeleteAction(clubSlug, sessionId);
        if (!result) setError("This event is no longer part of a series.");
        else setPlan(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the preview.");
      }
    });
  }

  function handleCancel() {
    setOpen(false);
    setPlan(null);
    setError(null);
  }

  function handleConfirm() {
    startTransition(async () => {
      try {
        const result = await deleteSeriesFromAction(clubSlug, sessionId);
        if (result.success) {
          // Stay locked (done) while navigating away; only failures unlock.
          setDone(true);
          router.push(clubPath(clubSlug, "/sessions"));
        } else {
          setError(result.message);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Deleting failed.");
      }
    });
  }

  if (!open) {
    return (
      <Button variant="destructive" size="sm" onClick={handleOpen}>
        Delete this and all later events
      </Button>
    );
  }

  const locked = isPending || done;
  const nothingToDelete = plan !== null && plan.toDelete.length === 0;

  return (
    <Card className="w-full" data-testid="series-delete-panel">
      <CardHeader>
        <CardTitle>Delete this and all later events</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!plan && !error && <p className="text-muted-foreground">Checking the series…</p>}
        {plan && (
          <>
            <p className="font-medium">{summary(plan)}</p>
            {plan.kept.length > 0 && (
              <ul className="list-disc pl-5 text-muted-foreground">
                {plan.kept.map((k) => (
                  <li key={k.id}>
                    {k.title}, {new Date(k.startsAt).toLocaleString()} ({plural(k.attendedCount, "attendee", "attendees")})
                  </li>
                ))}
              </ul>
            )}
            <p className="text-muted-foreground">This cannot be undone. Earlier events in the series are not affected.</p>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleConfirm}
            disabled={locked || !plan || nothingToDelete}
          >
            {isPending && plan ? "Deleting…" : "Confirm delete"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleCancel} disabled={locked}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

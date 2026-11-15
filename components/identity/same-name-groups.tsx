"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dismissSameNameGroupAction } from "@/lib/identity/actions";

export interface SameNameGroupItem {
  nameKey: string;
  membersHash: string;
  people: Array<{
    id: string;
    fullName: string;
    email: string | null;
    cid: string | null;
    cidSource: string | null;
    attendanceCount: number;
    purchaseCount: number;
  }>;
}

/** People sharing a full name, each group with a "Not the same person" dismissal. */
export function SameNameGroups({ clubSlug, groups }: { clubSlug: string; groups: SameNameGroupItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function dismiss(group: SameNameGroupItem) {
    const key = `${group.nameKey}:${group.membersHash}`;
    setBusy(key);
    startTransition(async () => {
      try {
        const result = await dismissSameNameGroupAction(clubSlug, group.nameKey, group.membersHash);
        if ("error" in result) toast.error(result.error);
        else toast.success("Marked as different people.");
        router.refresh();
      } catch {
        toast.error("Something went wrong. Please try again.");
      } finally {
        setBusy(null);
      }
    });
  }

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No people share a name.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {groups.map((g) => {
        const key = `${g.nameKey}:${g.membersHash}`;
        return (
          <li key={key} className="rounded-lg border p-4" data-testid="same-name-group">
            <div className="flex items-start justify-between gap-2">
              <div className="font-medium">
                {g.people[0]?.fullName.trim()} <span className="text-muted-foreground">({g.people.length})</span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={isPending}
                onClick={() => dismiss(g)}
              >
                {busy === key ? "Saving…" : "Not the same person"}
              </Button>
            </div>
            <ul className="mt-2 flex flex-col gap-2">
              {g.people.map((p) => (
                <li key={p.id} className="text-sm">
                  <div>{p.email ?? "No email"}</div>
                  <div className="text-xs text-muted-foreground">
                    CID {p.cid ?? "none"}
                    {p.cid && p.cidSource ? ` (${p.cidSource})` : ""}
                    {" · "}
                    {p.attendanceCount} attendance{p.attendanceCount === 1 ? "" : "s"}
                    {" · "}
                    {p.purchaseCount} purchase{p.purchaseCount === 1 ? "" : "s"}
                  </div>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

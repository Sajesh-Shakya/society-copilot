"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dismissSameNameGroupAction, mergeSameNameAction } from "@/lib/identity/actions";

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

  // Per group: which person to keep (default: the one with most records) and
  // which of the others to merge into them (default: all).
  const [keepByGroup, setKeepByGroup] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});

  function keeperOf(group: SameNameGroupItem, key: string): string {
    return (
      keepByGroup[key] ??
      [...group.people].sort(
        (a, b) => b.attendanceCount + b.purchaseCount - (a.attendanceCount + a.purchaseCount),
      )[0].id
    );
  }

  function merge(group: SameNameGroupItem) {
    const key = `${group.nameKey}:${group.membersHash}`;
    const keepId = keeperOf(group, key);
    const mergeIds = group.people.filter((p) => p.id !== keepId && !excluded[p.id]).map((p) => p.id);
    const keep = group.people.find((p) => p.id === keepId);
    if (
      !window.confirm(
        `Merge ${mergeIds.length} duplicate record${mergeIds.length === 1 ? "" : "s"} into ${keep?.email ?? "this person"}? Their attendance, purchases and chase emails move over and the duplicates are removed. This can't be undone from the app.`,
      )
    )
      return;
    setBusy(key);
    startTransition(async () => {
      try {
        const result = await mergeSameNameAction(clubSlug, keepId, mergeIds);
        if ("error" in result) toast.error(result.error);
        else toast.success(`Merged ${result.merged} duplicate${result.merged === 1 ? "" : "s"}.`);
        router.refresh();
      } catch {
        toast.error("Something went wrong. Please try again.");
      } finally {
        setBusy(null);
      }
    });
  }

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
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                <Button
                  size="sm"
                  disabled={isPending || g.people.filter((p) => p.id !== keeperOf(g, key) && !excluded[p.id]).length === 0}
                  onClick={() => merge(g)}
                >
                  {busy === key ? "Saving…" : "Same person — merge"}
                </Button>
                <Button size="sm" variant="secondary" disabled={isPending} onClick={() => dismiss(g)}>
                  Not the same person
                </Button>
              </div>
            </div>
            <ul className="mt-2 flex flex-col gap-2">
              {g.people.map((p) => (
                <li key={p.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="radio"
                        name={`keep-${key}`}
                        checked={keeperOf(g, key) === p.id}
                        onChange={() => setKeepByGroup((s) => ({ ...s, [key]: p.id }))}
                      />
                      Keep
                    </label>
                    {keeperOf(g, key) !== p.id && (
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={!excluded[p.id]}
                          onChange={(e) => setExcluded((s) => ({ ...s, [p.id]: !e.target.checked }))}
                        />
                        Merge in
                      </label>
                    )}
                    <span>{p.email ?? "No email"}</span>
                  </div>
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

"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resolveConflictAction, takeCidFromOtherPersonAction } from "@/lib/identity/actions";

export interface ConflictItem {
  id: string;
  personName: string;
  personEmail: string | null;
  currentCid: string | null;
  currentSource: string | null;
  incomingCid: string;
  incomingSource: string;
  otherPersonName: string | null;
  otherPersonSource: string | null;
  createdAt: string;
  canUseIncoming: boolean;
  canTake: boolean;
}

type Action = "keep" | "incoming" | "take";

const SUCCESS: Record<Action, string> = {
  keep: "Kept the current CID.",
  incoming: "Applied the incoming CID.",
  take: "Moved the CID to this person.",
};

function cidLabel(cid: string | null, source: string | null): string {
  if (!cid) return "none";
  return source ? `${cid} (${source})` : cid;
}

/** Open CID conflicts with "Keep current", "Use incoming" and "Take this CID from the other person". */
export function ConflictList({ clubSlug, conflicts }: { clubSlug: string; conflicts: ConflictItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function run(conflictId: string, action: Action) {
    startTransition(async () => {
      try {
        const result =
          action === "take"
            ? await takeCidFromOtherPersonAction(clubSlug, conflictId)
            : await resolveConflictAction(clubSlug, conflictId, action === "keep" ? "keep_current" : "use_incoming");
        if ("error" in result) {
          toast.error(result.error);
        } else {
          toast.success(SUCCESS[action]);
        }
        router.refresh();
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  if (conflicts.length === 0) {
    return <p className="text-sm text-muted-foreground">No open CID conflicts.</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {conflicts.map((c) => {
        const disabled = isPending;
        return (
          <li key={c.id} className="rounded-lg border p-4" data-testid="conflict-row">
            <div className="font-medium">{c.personName}</div>
            {c.personEmail && <div className="text-xs text-muted-foreground">{c.personEmail}</div>}
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Current CID</dt>
              <dd>{cidLabel(c.currentCid, c.currentSource)}</dd>
              <dt className="text-muted-foreground">Incoming CID</dt>
              <dd>{cidLabel(c.incomingCid, c.incomingSource)}</dd>
              {c.otherPersonName && (
                <>
                  <dt className="text-muted-foreground">Held by</dt>
                  <dd>
                    {c.otherPersonName}
                    {c.otherPersonSource ? ` (${c.otherPersonSource})` : ""}
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Flagged</dt>
              <dd>{new Date(c.createdAt).toLocaleString()}</dd>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => run(c.id, "keep")}>
                Keep current
              </Button>
              {c.canUseIncoming && (
                <Button size="sm" disabled={disabled} onClick={() => run(c.id, "incoming")}>
                  Use incoming
                </Button>
              )}
              {c.canTake && (
                <Button size="sm" disabled={disabled} onClick={() => run(c.id, "take")}>
                  Take this CID from the other person
                </Button>
              )}
            </div>
            {!c.canUseIncoming && !c.canTake && (
              <p className="mt-2 text-xs text-muted-foreground">
                Someone else holds the incoming CID with an equal or better source, so the only option is to keep the
                current CID.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

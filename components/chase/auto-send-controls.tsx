"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { revokeStandingApprovalAction, setAutoSendPausedAction } from "@/lib/chase/actions";

export interface StandingPerson {
  id: string;
  fullName: string;
  email: string;
  since: string;
}

export function AutoSendControls({
  clubSlug,
  paused,
  globalEnabled,
  people,
}: {
  clubSlug: string;
  paused: boolean;
  globalEnabled: boolean;
  people: StandingPerson[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function togglePause() {
    setBusy(true);
    try {
      const res = await setAutoSendPausedAction(clubSlug, !paused);
      if ("error" in res) toast.error(res.error);
      else {
        toast.success(paused ? "Auto-send resumed." : "Auto-send paused.");
        router.refresh();
      }
    } catch {
      toast.error("Could not change auto-send.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(personId: string) {
    setBusy(true);
    try {
      const res = await revokeStandingApprovalAction(clubSlug, personId);
      if (res.revoked) {
        toast.success("Revoked.");
        router.refresh();
      } else toast.error("Could not revoke.");
    } catch {
      toast.error("Revoke failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border p-4">
      {!globalEnabled && (
        <p className="mb-3 text-sm text-amber-600">
          Global auto-send is off; approved people will still need manual sends.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium">Auto-send is {paused ? "PAUSED" : "ON"} for this club</p>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={togglePause}>
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      <div className="mt-4">
        <p className="text-sm font-medium">People on auto-send ({people.length})</p>
        {people.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Nobody yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {people.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="break-words">
                  {p.fullName} ({p.email}){" "}
                  <span className="text-xs text-muted-foreground">
                    since {new Date(p.since).toLocaleDateString("en-GB")}
                  </span>
                </span>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => revoke(p.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

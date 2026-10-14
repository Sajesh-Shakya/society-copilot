"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { syncCsvToSession } from "@/lib/csv-import/actions";

/**
 * Re-syncs an already-created session's roster against a freshly
 * re-exported CSV -- the new file is treated as authoritative for who's
 * currently signed up, so this can both add new signups and remove
 * people who've since un-signed-up (see syncAttendanceCsv for the exact
 * rules; manually-added people and anyone already marked attended are
 * never removed). No title/start-time fields needed (the session already
 * has those); just a file picker. Triggers a full attendance-list
 * refetch via onSynced rather than trying to merge rows locally, since
 * the server action doesn't return which specific rows changed.
 */
export function SyncCsvButton({
  sessionId,
  onSynced,
}: {
  sessionId: string;
  onSynced: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, setIsPending] = useState(false);

  function handleFileChange() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.set("file", file);

    setIsPending(true);
    syncCsvToSession(sessionId, formData)
      .then((result) => {
        if (result.success) {
          toast.success(result.message);
          onSynced();
        } else {
          toast.error(result.message);
        }
      })
      .catch(() => toast.error("Sync failed unexpectedly."))
      .finally(() => {
        setIsPending(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      });
  }

  return (
    <>
      {/* sr-only, not hidden/display:none -- several mobile browsers
          (notably iOS Safari) refuse to open the native file picker for a
          programmatically-clicked input that's fully display:none. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        className="sr-only"
        onChange={handleFileChange}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => fileInputRef.current?.click()}
      >
        {isPending ? "Syncing…" : "Update from CSV"}
      </Button>
    </>
  );
}

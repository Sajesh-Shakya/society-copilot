"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { FilePickerButton, type FilePickerButtonHandle } from "@/components/ui/file-picker-button";
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
  const pickerRef = useRef<FilePickerButtonHandle>(null);
  const [isPending, setIsPending] = useState(false);

  function handleFileSelected(file: File) {
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
        pickerRef.current?.reset();
      });
  }

  return (
    <FilePickerButton
      ref={pickerRef}
      accept=".csv"
      size="sm"
      isLoading={isPending}
      loadingLabel="Syncing…"
      label="Update from CSV"
      onFileSelected={handleFileSelected}
    />
  );
}

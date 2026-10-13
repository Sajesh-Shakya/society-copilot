"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { appendCsvToSession } from "@/lib/csv-import/actions";

/**
 * Adds new people to an already-created session's roster from a CSV export
 * -- for when someone signs up after the session was first created/
 * imported. No title/start-time fields needed (the session already has
 * those); just a file picker. Triggers a full attendance-list refetch via
 * onImported rather than trying to merge rows locally, since the server
 * action doesn't return which specific rows were added vs skipped.
 */
export function AppendCsvButton({
  sessionId,
  onImported,
}: {
  sessionId: string;
  onImported: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isPending, setIsPending] = useState(false);

  function handleFileChange() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.set("file", file);

    setIsPending(true);
    appendCsvToSession(sessionId, formData)
      .then((result) => {
        if (result.success) {
          toast.success(result.message);
          onImported();
        } else {
          toast.error(result.message);
        }
      })
      .catch(() => toast.error("Import failed unexpectedly."))
      .finally(() => {
        setIsPending(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      });
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        className="hidden"
        onChange={handleFileChange}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => fileInputRef.current?.click()}
      >
        {isPending ? "Importing…" : "New people from CSV"}
      </Button>
    </>
  );
}

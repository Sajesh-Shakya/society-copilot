"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createSessionFromCsv } from "@/lib/csv-import/actions";

export function CsvImporter() {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CSV file.");
      return;
    }

    const formData = new FormData(e.currentTarget);
    // <input type="datetime-local"> has no timezone -- convert to a real
    // ISO instant (in the browser's local timezone) before sending, same
    // conversion components/attendance/session-picker.tsx already does.
    const startsAtRaw = String(formData.get("startsAt") ?? "");
    formData.set("startsAt", startsAtRaw ? new Date(startsAtRaw).toISOString() : "");

    setIsPending(true);
    try {
      const result = await createSessionFromCsv(formData);
      if (result.success && result.sessionId) {
        toast.success(result.message);
        router.push(`/sessions/${result.sessionId}`);
      } else {
        setError(result.message);
      }
    } catch {
      setError("Import failed unexpectedly.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="title">Session title</Label>
        <Input id="title" name="title" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="startsAt">Starts at</Label>
        <Input id="startsAt" name="startsAt" type="datetime-local" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="file">Attendee CSV (exported from eActivities&apos; dashboard)</Label>
        <input
          ref={fileInputRef}
          id="file"
          name="file"
          type="file"
          accept=".csv"
          required
          className="text-sm"
        />
      </div>
      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Importing…" : "Create session"}
      </Button>
      {error && <p className="text-sm text-destructive whitespace-pre-line">{error}</p>}
    </form>
  );
}

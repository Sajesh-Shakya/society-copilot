"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FilePickerButton } from "@/components/ui/file-picker-button";
import { clubPath } from "@/lib/club-path";
import { createRecurringSeriesAction } from "@/lib/session-series/actions";

export function RecurringSessionForm({ clubSlug }: { clubSlug: string }) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    // Dates and times are sent exactly as typed: the server interprets them
    // as Europe/London, so no browser-timezone conversion happens here.
    const formData = new FormData(e.currentTarget);

    setIsPending(true);
    try {
      const result = await createRecurringSeriesAction(clubSlug, formData);
      if (result.success && result.firstSessionId) {
        toast.success(result.message);
        router.push(clubPath(clubSlug, `/sessions/${result.firstSessionId}`));
      } else {
        setError(result.message);
      }
    } catch {
      setError("Creating the series failed unexpectedly.");
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
        <Label htmlFor="firstDate">First session date</Label>
        <Input id="firstDate" name="firstDate" type="date" required />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="startTime">Start time</Label>
          <Input id="startTime" name="startTime" type="time" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="endTime">End time</Label>
          <Input id="endTime" name="endTime" type="time" required />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="untilDate">Repeat weekly until</Label>
        <Input id="untilDate" name="untilDate" type="date" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="file">Signup CSV (optional)</Label>
        <FilePickerButton
          id="file"
          name="file"
          accept=".csv"
          label="Choose CSV file"
          disabled={isPending}
          onFileSelected={() => {}}
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Times are Europe/London. The CSV applies to the first session only.
      </p>
      <Button type="submit" disabled={isPending} className="self-start">
        {isPending ? "Creating…" : "Create series"}
      </Button>
      {error && <p className="text-sm text-destructive whitespace-pre-line">{error}</p>}
    </form>
  );
}

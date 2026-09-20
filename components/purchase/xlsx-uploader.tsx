"use client";

import { useRef, useState } from "react";
import { uploadXlsx } from "@/lib/xlsx/uploader";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function XlsxUploader() {
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);

    setIsLoading(true);
    try {
      const result = await uploadXlsx(formData);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch {
      toast.error("Upload failed");
    } finally {
      setIsLoading(false);
      // Reset so re-selecting the same file re-fires onChange.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        onChange={handleUpload}
        disabled={isLoading}
        className="hidden"
        id="xlsx-upload-input"
      />
      <Button
        type="button"
        variant="outline"
        disabled={isLoading}
        onClick={() => inputRef.current?.click()}
      >
        {isLoading ? "Uploading..." : "Upload XLSX"}
      </Button>
      <span className="text-sm text-muted-foreground">
        Upload XLSX to ingest purchases
      </span>
    </div>
  );
}

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadXlsx } from "@/lib/xlsx/uploader";
import { FilePickerButton, type FilePickerButtonHandle } from "@/components/ui/file-picker-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { parseSalesId } from "@/lib/purchase/sales-id";
import type { ProductListItem } from "@/lib/purchase/queries";

export function XlsxUploader({ clubSlug, products }: { clubSlug: string; products: ProductListItem[] }) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [productId, setProductId] = useState<string>("");
  // A file whose product was guessed from its filename waits here for the
  // admin to confirm, instead of uploading straight away.
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const pickerRef = useRef<FilePickerButtonHandle>(null);

  function handleFileSelected(file: File) {
    if (!productId) {
      const salesId = parseSalesId(file.name);
      const matches = salesId ? products.filter((p) => p.externalSalesId === salesId) : [];
      if (matches.length === 1) {
        setProductId(matches[0].id);
        setPendingFile(file);
      } else {
        toast.error("Pick a pass type first");
        pickerRef.current?.reset();
      }
      return;
    }
    setPendingFile(null);
    upload(file, productId);
  }

  function upload(file: File, chosenProductId: string) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("productId", chosenProductId);

    setIsLoading(true);
    uploadXlsx(clubSlug, formData)
      .then((result) => {
        if (result.success) {
          toast.success(result.message);
          // Without this, the new entry in "Recent uploads" and the new
          // rows in "Recent Purchases" below only appeared after a
          // manual page reload -- this page's data is server-rendered,
          // so a client-side mutation needs an explicit refresh to show
          // up at all, same admin or not.
          router.refresh();
        } else {
          toast.error(result.message);
        }
      })
      .catch(() => toast.error("Upload failed"))
      .finally(() => {
        setIsLoading(false);
        setPendingFile(null);
        pickerRef.current?.reset();
      });
  }

  return (
    <div className="flex flex-col gap-3">
      <Select
        value={productId}
        onValueChange={(value) => {
          setProductId(value);
          setPendingFile(null);
        }}
        disabled={isLoading}
      >
        <SelectTrigger className="w-full sm:w-64">
          <SelectValue placeholder="Which pass is this file for?" />
        </SelectTrigger>
        <SelectContent>
          {products.map((product) => (
            <SelectItem key={product.id} value={product.id}>
              {product.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <FilePickerButton
        ref={pickerRef}
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        isLoading={isLoading}
        loadingLabel="Uploading…"
        label="Upload XLSX"
        noFileLabel="No file chosen"
        onFileSelected={handleFileSelected}
      />
      {pendingFile && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">Picked from filename — check it&apos;s right.</span>
          <Button size="sm" disabled={isLoading} onClick={() => upload(pendingFile, productId)}>
            Upload as {products.find((p) => p.id === productId)?.name}
          </Button>
        </div>
      )}
    </div>
  );
}

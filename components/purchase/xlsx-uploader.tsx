"use client";

import { useRef, useState } from "react";
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
import type { ProductListItem } from "@/lib/purchase/queries";

export function XlsxUploader({ products }: { products: ProductListItem[] }) {
  const [isLoading, setIsLoading] = useState(false);
  const [productId, setProductId] = useState<string>("");
  const pickerRef = useRef<FilePickerButtonHandle>(null);

  function handleFileSelected(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("productId", productId);

    setIsLoading(true);
    uploadXlsx(formData)
      .then((result) => {
        if (result.success) {
          toast.success(result.message);
        } else {
          toast.error(result.message);
        }
      })
      .catch(() => toast.error("Upload failed"))
      .finally(() => {
        setIsLoading(false);
        pickerRef.current?.reset();
      });
  }

  return (
    <div className="flex flex-col gap-3">
      <Select value={productId} onValueChange={setProductId} disabled={isLoading}>
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
        accept=".xlsx"
        disabled={!productId}
        isLoading={isLoading}
        loadingLabel="Uploading…"
        label="Upload XLSX"
        noFileLabel={productId ? "No file chosen" : "Pick a pass type first"}
        onFileSelected={handleFileSelected}
      />
    </div>
  );
}

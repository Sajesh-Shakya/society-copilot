"use client";

import { useRef, useState } from "react";
import { uploadXlsx } from "@/lib/xlsx/uploader";
import { Button } from "@/components/ui/button";
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
  const [fileName, setFileName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("productId", productId);

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
      setFileName(null);
    }
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

      <div className="flex items-center gap-3">
        {/* sr-only, not hidden/display:none -- several mobile browsers
            (notably iOS Safari) refuse to open the native file picker for
            a programmatically-clicked input that's fully display:none. */}
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          onChange={handleUpload}
          disabled={isLoading || !productId}
          className="sr-only"
          id="xlsx-upload-input"
        />
        <Button
          type="button"
          variant="outline"
          disabled={isLoading || !productId}
          onClick={() => inputRef.current?.click()}
        >
          {isLoading ? "Uploading…" : "Upload XLSX"}
        </Button>
        <span className="text-sm text-muted-foreground">
          {fileName ?? (productId ? "No file chosen" : "Pick a pass type first")}
        </span>
      </div>
    </div>
  );
}

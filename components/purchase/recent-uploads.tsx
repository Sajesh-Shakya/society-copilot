"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { changeUploadProduct, undoUpload } from "@/lib/purchase/actions";
import type { UploadBatch } from "@/lib/purchase/interface";
import type { ProductListItem } from "@/lib/purchase/queries";

/**
 * The last few XLSX uploads, so an accidental wrong-product pick can be
 * corrected (change the product every row in that batch was recorded
 * against, re-waiving under the new rule) or undone entirely (delete the
 * whole batch) -- without ever having had a way to tell which purchase
 * rows even came from the same upload before this existed.
 */
export function RecentUploads({
  uploads,
  products,
}: {
  uploads: UploadBatch[];
  products: ProductListItem[];
}) {
  if (uploads.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-muted-foreground">Recent uploads</h3>
      <div className="flex flex-col gap-2">
        {uploads.map((upload) => (
          <UploadRow key={upload.id} upload={upload} products={products} />
        ))}
      </div>
    </div>
  );
}

function UploadRow({ upload, products }: { upload: UploadBatch; products: ProductListItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmingUndo, setConfirmingUndo] = useState(false);

  function handleProductChange(newProductId: string) {
    if (newProductId === upload.productId) return;
    startTransition(async () => {
      try {
        const result = await changeUploadProduct(upload.id, newProductId);
        toast.success(
          `Updated ${result.purchasesUpdated} purchase(s)${result.rewaived > 0 ? `, re-waived ${result.rewaived} session(s)` : ""}.`
        );
        router.refresh();
      } catch {
        toast.error("Couldn't change this upload's product.");
      }
    });
  }

  function handleUndo() {
    if (!confirmingUndo) {
      setConfirmingUndo(true);
      return;
    }
    startTransition(async () => {
      try {
        const result = await undoUpload(upload.id);
        toast.success(`Undone — removed ${result.deletedPurchases} purchase(s).`);
        router.refresh();
      } catch {
        toast.error("Couldn't undo this upload.");
      } finally {
        setConfirmingUndo(false);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border-2 border-border px-3 py-2 text-sm">
      <span className="text-muted-foreground">{new Date(upload.createdAt).toLocaleString()}</span>
      <span className="font-medium">{upload.filename ?? "(unnamed file)"}</span>
      <span className="text-muted-foreground">{upload.rowCount} row(s)</span>
      <Select value={upload.productId} onValueChange={handleProductChange} disabled={isPending}>
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {products.map((product) => (
            <SelectItem key={product.id} value={product.id}>
              {product.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant={confirmingUndo ? "destructive" : "ghost"}
        size="sm"
        disabled={isPending}
        onClick={handleUndo}
        onBlur={() => setConfirmingUndo(false)}
      >
        {confirmingUndo ? "Click again to confirm undo" : "Undo"}
      </Button>
    </div>
  );
}

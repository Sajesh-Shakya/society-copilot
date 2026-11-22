"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { createProductAction, updateProductAction, applyPriceAction } from "@/lib/products/actions";
import type { ProductRow } from "@/lib/products/queries";

const KINDS = [
  { value: "session_pass", label: "Session pass" },
  { value: "term_pass", label: "Term pass" },
  { value: "annual_pass", label: "Annual pass" },
  { value: "other", label: "Other" },
] as const;

function poundsFromPence(pence: number | null): string {
  return pence === null ? "" : (pence / 100).toFixed(2);
}

// Empty -> null (unpriced). Returns undefined for unparseable input.
function penceFromPounds(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(parseFloat(t) * 100);
}

function ProductRowEditor({ clubSlug, product }: { clubSlug: string; product: ProductRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [price, setPrice] = useState(poundsFromPence(product.pricePence));
  const [salesId, setSalesId] = useState(product.externalSalesId ?? "");

  function run(fn: () => Promise<{ error: string } | object>, success: string) {
    startTransition(async () => {
      const res = await fn();
      if ("error" in res) toast.error(res.error as string);
      else {
        toast.success(success);
        router.refresh();
      }
    });
  }

  function save() {
    const pence = penceFromPounds(price);
    if (pence === undefined) return toast.error("Price must be a number like 5 or 5.00");
    run(
      () => updateProductAction(clubSlug, product.id, { pricePence: pence, externalSalesId: salesId.trim() || null }),
      "Saved"
    );
  }

  const canApply = product.pricePence !== null && product.unpricedPurchaseCount > 0;

  return (
    <div className={"rounded-lg border p-3 " + (product.active ? "" : "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{product.name}</span>
        <Badge variant="secondary">{KINDS.find((k) => k.value === product.kind)?.label ?? product.kind}</Badge>
        <span className="text-xs text-muted-foreground">{product.purchaseCount} purchases</span>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          Price (£)
          <Input className="mt-1 w-28" inputMode="decimal" value={price} placeholder="unpriced" onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Sales ID
          <Input className="mt-1 w-28" value={salesId} placeholder="e.g. 2880" onChange={(e) => setSalesId(e.target.value)} />
        </label>
        <Button size="sm" onClick={save} disabled={pending}>Save</Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => run(() => updateProductAction(clubSlug, product.id, { active: !product.active }), product.active ? "Retired" : "Restored")}
        >
          {product.active ? "Retire" : "Restore"}
        </Button>
        {canApply && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => applyPriceAction(clubSlug, product.id), "Price applied")}
          >
            Apply price to {product.unpricedPurchaseCount} unpriced purchases
          </Button>
        )}
      </div>
    </div>
  );
}

function AddProductForm({ clubSlug }: { clubSlug: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("session_pass");
  const [sessions, setSessions] = useState("1");
  const [price, setPrice] = useState("");
  const [salesId, setSalesId] = useState("");

  function submit() {
    const pence = penceFromPounds(price);
    if (pence === undefined) return toast.error("Price must be a number like 5 or 5.00");
    startTransition(async () => {
      const res = await createProductAction(clubSlug, {
        name,
        kind,
        coversSessions: sessions.trim() === "" ? null : parseInt(sessions, 10),
        pricePence: pence,
        externalSalesId: salesId.trim() || null,
      });
      if ("error" in res) toast.error(res.error);
      else {
        toast.success("Product added");
        setName("");
        setPrice("");
        setSalesId("");
        router.refresh();
      }
    });
  }

  return (
    <div className="rounded-lg border p-4">
      <h2 className="font-semibold">Add product</h2>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted-foreground">
          Name
          <Input className="mt-1 w-56" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Kind
          <select
            className="mt-1 block h-9 rounded-md border bg-background px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Sessions covered
          <Input className="mt-1 w-24" inputMode="numeric" value={sessions} onChange={(e) => setSessions(e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Price (£)
          <Input className="mt-1 w-24" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="text-xs text-muted-foreground">
          Sales ID
          <Input className="mt-1 w-24" value={salesId} onChange={(e) => setSalesId(e.target.value)} />
        </label>
        <Button onClick={submit} disabled={pending}>Add</Button>
      </div>
    </div>
  );
}

export function ProductManager({ clubSlug, products }: { clubSlug: string; products: ProductRow[] }) {
  const active = products.filter((p) => p.active);
  const retired = products.filter((p) => !p.active);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {active.length === 0 && <p className="text-sm text-muted-foreground">No active products yet.</p>}
        {active.map((p) => (
          <ProductRowEditor key={p.id} clubSlug={clubSlug} product={p} />
        ))}
      </div>
      <AddProductForm clubSlug={clubSlug} />
      {retired.length > 0 && (
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold">Retired</h2>
          {retired.map((p) => (
            <ProductRowEditor key={p.id} clubSlug={clubSlug} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}

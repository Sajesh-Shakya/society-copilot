"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface PurchaseRow {
  id: string;
  rawPersonName: string;
  rawCid: string | null;
  rawEmail: string | null;
  productName: string | null;
  matchStatus: string;
  matchedPersonName: string | null;
  source: string;
  purchasedAt: string;
}

const MATCH_STATUS_VARIANT: Record<string, "secondary" | "destructive"> = {
  cid_matched: "secondary",
  email_matched: "secondary",
  name_matched: "secondary",
  manual_matched: "secondary",
  unmatched: "destructive",
};

/**
 * Previously showed only Source/Status/Purchased -- an unmatched row gave
 * no way to tell WHO it was or why matching failed (reported directly:
 * "I have no idea who this is or how to debug"). Name and CID (the two
 * fields lib/purchase/matcher.ts actually matches on) are always visible;
 * email is behind a toggle rather than always-on, matching the existing
 * "Show emails" pattern on the attendance screen.
 */
export function PurchasesTable({ purchases }: { purchases: PurchaseRow[] }) {
  const [showEmails, setShowEmails] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setShowEmails((v) => !v)}>
          {showEmails ? "Hide emails" : "Show emails"}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border-2 border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b-2 border-border">
              <th className="whitespace-nowrap px-3 py-2 text-left">Name</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">CID</th>
              {showEmails && <th className="whitespace-nowrap px-3 py-2 text-left">Email</th>}
              <th className="whitespace-nowrap px-3 py-2 text-left">Product</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Status</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Source</th>
              <th className="whitespace-nowrap px-3 py-2 text-left">Purchased</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => (
              <tr key={p.id} className="border-b-2 border-border">
                <td className="whitespace-nowrap px-3 py-2">
                  {p.rawPersonName}
                  {p.matchStatus !== "unmatched" && p.matchedPersonName && p.matchedPersonName !== p.rawPersonName && (
                    <span className="ml-1 text-xs text-muted-foreground">(matched: {p.matchedPersonName})</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{p.rawCid ?? "—"}</td>
                {showEmails && (
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{p.rawEmail ?? "—"}</td>
                )}
                <td className="whitespace-nowrap px-3 py-2">{p.productName ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <Badge variant={MATCH_STATUS_VARIANT[p.matchStatus] ?? "secondary"}>{p.matchStatus}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{p.source}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {new Date(p.purchasedAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

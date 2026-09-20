// STUB: no real Pluto API documentation exists yet (see core/INTEGRATIONS.md
// "Pluto adapter" — "being rolled out progressively... should be treated as
// a future provider"). This class exists so the purchase-ingestion seam
// (PurchaseIngestionAdapter in core/INTEGRATIONS.md) has a named home for
// the real client once Pluto's API is documented. Do not wire this into any
// scheduled job or UI until it's implemented for real.

export interface PlutoSale {
  id: string;
  name: string;
  email?: string;
  cid?: string;
  memberType: string;
  productName: string;
  purchasedAt: string;
}

export class PlutoClient {
  async getSales(_since?: Date): Promise<PlutoSale[]> {
    throw new Error(
      "Pluto integration not yet implemented — no API documentation " +
      "available. See core/INTEGRATIONS.md 'Pluto adapter'."
    );
  }
}

// Incoming row from either Pluto or XLSX
export interface RawPurchaseRow {
  externalId: string;              // Pluto sale ID or XLSX row hash
  personName: string;
  personEmail?: string;            // optional, varies by source
  personCid?: string;              // optional, Pluto provides, XLSX may not
  memberType: string;              // "Student", "Public", "Associate", etc.
  productName: string;
  purchasedAt: Date;
  source: 'pluto_api' | 'xlsx_upload';
}

// Result of matching attempt
export interface MatchResult {
  personId?: string;               // null if unmatched
  matchStatus: 'cid_matched' | 'email_matched' | 'manual_matched' | 'unmatched';
  confidence?: 'high' | 'medium' | 'low';
}

// Final record ready to insert
export interface PurchaseRecord {
  personId: string | null;
  productId: string;               // must exist in db
  source: 'pluto_api' | 'xlsx_upload';
  sourceRowId: string;
  rawMemberType: string;
  isStudent: boolean;
  matchStatus: MatchResult['matchStatus'];
  purchasedAt: Date;
}

// Return from ingestPurchases()
export interface IngestionResult {
  inserted: number;
  duplicates: number;
  errors: IngestionError[];
}

export interface IngestionError {
  rowId: string;
  reason: string;
  rawRow: RawPurchaseRow;
}

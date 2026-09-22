# Purchase Ingestion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest purchase/membership data from XLSX uploads (the real path today), matching buyers to existing people records or queuing for manual review. Reserve the seam for a real Pluto API adapter later — no real Pluto API documentation exists yet (see Task 3's ruling below), so this phase ships a stub client rather than an invented integration.

**Architecture:** A shared `purchase` ingestion interface derives `is_student` from `Member Type`, matches buyers to `person` records via CID (for students) or email (for everyone), and queues unmatched rows for admin review. Idempotency is enforced via `UNIQUE(source, source_row_id)` — XLSX rows are hashed to derive a stable ID. The interface is source-agnostic (`source: 'pluto_api' | 'xlsx_upload'`) so a real Pluto adapter can be dropped in later without touching matching/dedup logic.

**Tech Stack:** Next.js Server Actions (for XLSX upload), Supabase MCP tools (for queries), SHA-256 hashing (stable XLSX row IDs), Zod validation, TypeScript.

**Spec:** [docs/superpowers/specs/2026-09-19-admin-auth-design.md](../specs/2026-09-19-admin-auth-design.md) + [specs/attendance-payment-chasing/design.md](../attendance-payment-chasing/design.md) + [specs/attendance-payment-chasing/requirements.md](../attendance-payment-chasing/requirements.md) (MP-4, MP-5, MP-6 requirements; identity matching per source-draft.md)

## Global Constraints

- Idempotency: `UNIQUE(source, source_row_id)` constraint enforced at DB level; re-uploads/re-polls create zero new rows.
- `is_student` is binary: `true` only on exact `Student` match, `false` for all others (Public, Associate, Staff, unrecognized).
- CID-priority identity matching for `is_student = true`; email-match-or-queue for `is_student = false`.
- All purchase data flows through the same internal interface (both Pluto and XLSX must use it).
- Unmatched rows are queued with `match_status = 'unmatched'`, `person_id = null`.
- All ingestion is idempotent and never mutates existing rows — only inserts or leaves them unchanged.
- Audit trail: `raw_member_type` retained verbatim, `matched_by` / `matched_at` recorded for manual matches.

---

## File Structure

```
lib/
  purchase/
    types.ts                 — PurchaseRow, IngestionResult, MatchResult types
    interface.ts             — shared interface (ingest, applyWaivers)
    matcher.ts               — CID-first matching logic
    
  pluto/
    client.ts                — STUB PlutoClient (throws — no real API docs yet)
    
  xlsx/
    parser.ts                — parse XLSX, hash rows, extract fields
    uploader.ts              — Server Action for file upload (gated by requireAdmin, called directly from the client component below — no separate API route)
    
components/
  purchase/
    xlsx-uploader.tsx        — Client component: file input + upload form
    manual-match-queue.tsx   — (Phase 5/6 scope — not this phase)
    
(Note: no Pluto polling/cron in this phase — see Task 3's ruling. XLSX is the only real ingestion path, via manual upload in the UI.)
```

---

## Task Breakdown

### Task 1: Define Shared Purchase-Ingestion Interface

**Files:**
- Create: `lib/purchase/types.ts`
- Create: `lib/purchase/interface.ts`

**Interfaces:**
- Consumes: Supabase `purchase`/`person` tables (existing schema)
- Produces: `ingestPurchases()` function signature, `MatchResult` type, error handling patterns

- [ ] **Step 1: Define types in lib/purchase/types.ts**

```typescript
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
```

- [ ] **Step 2: Define ingestPurchases interface in lib/purchase/interface.ts**

```typescript
import { RawPurchaseRow, IngestionResult } from './types';

export async function ingestPurchases(rows: RawPurchaseRow[]): Promise<IngestionResult> {
  // 1. Validate each row with Zod
  // 2. Derive is_student from raw memberType
  // 3. Match each row to a person (or queue for manual review)
  // 4. Build purchase records
  // 5. Upsert via INSERT ... ON CONFLICT (source, source_row_id) DO NOTHING
  // 6. Return counts
}

export async function applyWaivers(personId: string, purchaseId: string): Promise<void> {
  // (Phase 5 scope — not this task; stub for interface completeness)
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add lib/purchase/
git commit -m "feat(purchase): define shared ingestion interface types"
```

---

### Task 2: Implement CID-Priority Identity Matcher

**Files:**
- Create: `lib/purchase/matcher.ts`

**Interfaces:**
- Consumes: `person` table (CID, email), `RawPurchaseRow`, `MatchResult` types
- Produces: `matchPersonRecord()` function

- [ ] **Step 1: Implement CID-first matching logic**

```typescript
// lib/purchase/matcher.ts
import { createAdminClient } from '@/lib/supabase/admin';
import { RawPurchaseRow, MatchResult } from './types';

export async function matchPersonRecord(row: RawPurchaseRow): Promise<MatchResult> {
  const admin = createAdminClient();
  
  // Rule 1: If row has CID, look for exact CID match
  if (row.personCid) {
    const { data } = await admin
      .from('person')
      .select('id')
      .eq('cid', row.personCid)
      .maybeSingle();
    
    if (data) {
      return { personId: data.id, matchStatus: 'cid_matched' };
    }
  }
  
  // Rule 2: If is_student = true and CID didn't match, stop here (no email fallback for students)
  if (row.personCid && row.memberType.toLowerCase() === 'student') {
    return { matchStatus: 'unmatched' };
  }
  
  // Rule 3: For non-students (or students with no CID), try email match
  if (row.personEmail) {
    const { data } = await admin
      .from('person')
      .select('id')
      .eq('email', row.personEmail.toLowerCase())
      .maybeSingle();
    
    if (data) {
      return { personId: data.id, matchStatus: 'email_matched' };
    }
  }
  
  // Rule 4: No match found
  return { matchStatus: 'unmatched' };
}

export async function matchOrQueue(
  rows: RawPurchaseRow[]
): Promise<{ matched: Map<string, MatchResult>; unmatched: RawPurchaseRow[] }> {
  const matched = new Map<string, MatchResult>();
  const unmatched: RawPurchaseRow[] = [];
  
  for (const row of rows) {
    const result = await matchPersonRecord(row);
    if (result.matchStatus === 'unmatched') {
      unmatched.push(row);
    } else {
      matched.set(row.externalId, result);
    }
  }
  
  return { matched, unmatched };
}
```

- [ ] **Step 2: Write tests (inline verification)**

Test via SQL:
```sql
-- Insert a student with CID, email
INSERT INTO person (cid, email, full_name) VALUES ('s123', 'alice@example.com', 'Alice');

-- Simulate ingest of a purchase from that CID
SELECT * FROM person WHERE cid = 's123';  -- should match

-- Simulate ingest of a non-student email, no CID
-- Should match via email
SELECT * FROM person WHERE email = 'alice@example.com';  -- should match
```

- [ ] **Step 3: Verify tsc**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add lib/purchase/matcher.ts
git commit -m "feat(purchase): implement CID-priority identity matching"
```

---

### Task 3: Stub Pluto Adapter (no real API docs available)

**Ruling (2026-09-20):** `core/INTEGRATIONS.md`'s "Pluto adapter" section
confirms Pluto has no real API contract yet ("being rolled out
progressively... should be treated as a future provider"), unlike
eActivities which has a fully-documented real endpoint. Building a client
against an invented URL/response-shape would ship code that looks like a
working integration but isn't — worse than not building it. User decision:
build a clearly-stubbed seam (matching `core/INTEGRATIONS.md`'s
`PurchaseIngestionAdapter` shape) that throws a descriptive "not yet
implemented" error, and rely on XLSX upload (Task 4) as the only real
ingestion path for now. Rewrite Task 3 for real once Pluto's actual API
docs exist — do not treat this stub as a template for the real shape.

**Files:**
- Create: `lib/pluto/client.ts`

**Interfaces:**
- Consumes: nothing (no real integration yet)
- Produces: `PlutoClient` class with a `getSales()` method that throws
  `Error("Pluto integration not yet implemented — no API documentation available. See core/INTEGRATIONS.md 'Pluto adapter'.")`
  — this is a deliberate not-implemented stub, not a bug to silently fix.
  No `poller.ts`, no `pollPluto()`, no cron/scheduled job wiring for this
  task — there's nothing real to poll yet.

- [ ] **Step 1: Implement the stub PlutoClient**

```typescript
// lib/pluto/client.ts
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
```

- [ ] **Step 2: Verify tsc and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: No errors. (The stub compiles; it's just not callable without
throwing, by design.)

- [ ] **Step 3: Commit**

```bash
git add lib/pluto/
git commit -m "feat(purchase): add stub PlutoClient pending real API docs

No real Pluto API documentation exists yet (core/INTEGRATIONS.md's Pluto
adapter section treats it as a future provider). This stub reserves the
seam and fails loudly rather than integrating against an invented API
shape. XLSX upload (Task 4) is the real ingestion path for now."
```

---

### Task 4: Implement XLSX Upload Adapter

**Files:**
- Create: `lib/xlsx/parser.ts`
- Create: `lib/xlsx/uploader.ts` (Server Action)
- Create: `components/purchase/xlsx-uploader.tsx` (Client component)

**Note:** no separate API route — `components/purchase/xlsx-uploader.tsx`
calls the `uploadXlsx` Server Action directly (standard Next.js App Router
pattern: Client Components import and call Server Actions like functions,
no HTTP round trip needed). A REST endpoint would be dead code here since
nothing else needs to POST to it.

**Interfaces:**
- Consumes: File upload, `ingestPurchases()` interface, `requireAdmin()`
- Produces: Upload Server Action, client form component (no separate API endpoint)

**Prerequisites:**
- The `xlsx` package is not yet a dependency (confirmed via `grep xlsx package.json` — not installed). Install it as Step 1 below before writing code that imports it.

- [ ] **Step 1: Install the xlsx package**

Run: `npm install xlsx`
Expected: `package.json` and `package-lock.json` gain an `xlsx` entry; no install errors.

- [ ] **Step 2: Implement XLSX parser with row hashing**

```typescript
// lib/xlsx/parser.ts
import crypto from 'crypto';
import { read, utils } from 'xlsx';
import { z } from 'zod';
import { RawPurchaseRow } from '@/lib/purchase/types';

const XlsxRowSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  cid: z.string().optional(),
  member_type: z.string().min(1),
  product_name: z.string().min(1),
  purchased_at: z.string().datetime(),
});

export function hashXlsxRow(row: Record<string, any>): string {
  const str = JSON.stringify(row);
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function parseXlsxFile(buffer: Buffer): RawPurchaseRow[] {
  const workbook = read(buffer);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = utils.sheet_to_json(sheet);
  
  const result: RawPurchaseRow[] = [];
  
  for (const row of rows) {
    try {
      const validated = XlsxRowSchema.parse(row);
      const rowHash = hashXlsxRow(row);
      
      result.push({
        externalId: rowHash,
        personName: validated.name,
        personEmail: validated.email,
        personCid: validated.cid,
        memberType: validated.member_type,
        productName: validated.product_name,
        purchasedAt: new Date(validated.purchased_at),
        source: 'xlsx_upload' as const,
      });
    } catch (error) {
      console.warn(`Skipping invalid XLSX row:`, error);
    }
  }
  
  return result;
}
```

- [ ] **Step 3: Implement upload Server Action**

```typescript
// lib/xlsx/uploader.ts
'use server';

import { requireAdmin } from '@/lib/auth/require-admin';
import { parseXlsxFile } from './parser';
import { ingestPurchases } from '@/lib/purchase/interface';

export async function uploadXlsx(formData: FormData): Promise<{ success: boolean; message: string }> {
  await requireAdmin();
  
  const file = formData.get('file') as File;
  if (!file) return { success: false, message: 'No file provided' };
  
  if (!file.name.endsWith('.xlsx')) {
    return { success: false, message: 'File must be .xlsx format' };
  }
  
  const buffer = await file.arrayBuffer();
  const rows = parseXlsxFile(Buffer.from(buffer));
  
  if (rows.length === 0) {
    return { success: false, message: 'No valid rows found in XLSX' };
  }
  
  const result = await ingestPurchases(rows);
  
  return {
    success: true,
    message: `Ingested ${result.inserted} new purchases (${result.duplicates} duplicates, ${result.errors.length} errors)`,
  };
}
```

- [ ] **Step 4: Create client component**

```typescript
// components/purchase/xlsx-uploader.tsx
'use client';

import { useState } from 'react';
import { uploadXlsx } from '@/lib/xlsx/uploader';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

export function XlsxUploader() {
  const [isLoading, setIsLoading] = useState(false);
  
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    setIsLoading(true);
    try {
      const result = await uploadXlsx(formData);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error('Upload failed');
    } finally {
      setIsLoading(false);
    }
  }
  
  return (
    <div className="flex items-center gap-2">
      <input
        type="file"
        accept=".xlsx"
        onChange={handleUpload}
        disabled={isLoading}
      />
      <span className="text-sm text-muted-foreground">Upload XLSX to ingest purchases</span>
    </div>
  );
}
```

- [ ] **Step 5: Verify tsc and build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json lib/xlsx/ components/purchase/xlsx-uploader.tsx
git commit -m "feat(purchase): implement XLSX upload adapter"
```

---

### Task 5: Integrate Purchase Ingestion with Identity Matching & is_student Derivation

**Files:**
- Modify: `lib/purchase/interface.ts` (implement full ingestPurchases body)

**Interfaces:**
- Consumes: `ingestPurchases` signature, `matchOrQueue()`, `person`/`product`/`purchase` tables
- Produces: Complete `ingestPurchases()` implementation

- [ ] **Step 1: Implement full ingestPurchases with is_student derivation and matching**

```typescript
// lib/purchase/interface.ts (complete implementation)
import { createAdminClient } from '@/lib/supabase/admin';
import { RawPurchaseRow, PurchaseRecord, IngestionResult, IngestionError } from './types';
import { matchOrQueue } from './matcher';
import { z } from 'zod';

const isStudentSchema = z.enum(['Student']).optional().catch(undefined);

export async function ingestPurchases(rows: RawPurchaseRow[]): Promise<IngestionResult> {
  const admin = createAdminClient();
  const errors: IngestionError[] = [];
  
  // Step 1: Validate rows with Zod
  const validRows: RawPurchaseRow[] = [];
  for (const row of rows) {
    try {
      // Basic validation
      if (!row.personName || !row.memberType || !row.productName || !row.purchasedAt) {
        throw new Error('Missing required fields');
      }
      validRows.push(row);
    } catch (error) {
      errors.push({
        rowId: row.externalId,
        reason: String(error),
        rawRow: row,
      });
    }
  }
  
  // Step 2: Match rows to people (or queue for manual review)
  const { matched, unmatched } = await matchOrQueue(validRows);
  
  // Step 3: Get or create products
  const productMap = new Map<string, string>();
  for (const row of validRows) {
    if (!productMap.has(row.productName)) {
      const { data } = await admin
        .from('product')
        .select('id')
        .eq('name', row.productName)
        .maybeSingle();
      
      if (data) {
        productMap.set(row.productName, data.id);
      } else {
        // Auto-create product if it doesn't exist (for simplicity)
        const { data: newProduct } = await admin
          .from('product')
          .insert({ name: row.productName, kind: 'other' })
          .select('id')
          .single();
        
        if (newProduct) {
          productMap.set(row.productName, newProduct.id);
        }
      }
    }
  }
  
  // Step 4: Build purchase records with is_student derivation
  const purchases: (PurchaseRecord & { sourceRowId: string })[] = [];
  
  for (const row of validRows) {
    const matchResult = matched.get(row.externalId);
    const productId = productMap.get(row.productName);
    
    if (!productId) {
      errors.push({
        rowId: row.externalId,
        reason: 'Could not resolve product name',
        rawRow: row,
      });
      continue;
    }
    
    // Derive is_student: true ONLY on exact "Student" match
    const isStudent = row.memberType === 'Student';
    
    purchases.push({
      personId: matchResult?.personId || null,
      productId,
      source: row.source,
      sourceRowId: row.externalId,
      rawMemberType: row.memberType,
      isStudent,
      matchStatus: matchResult?.matchStatus || 'unmatched',
      purchasedAt: row.purchasedAt,
    });
  }
  
  // Step 5: Upsert via INSERT ... ON CONFLICT DO NOTHING (idempotent)
  let inserted = 0;
  let duplicates = 0;
  
  for (const purchase of purchases) {
    const { error } = await admin
      .from('purchase')
      .insert({
        person_id: purchase.personId,
        product_id: purchase.productId,
        source: purchase.source,
        source_row_id: purchase.sourceRowId,
        raw_member_type: purchase.rawMemberType,
        match_status: purchase.matchStatus,
        purchased_at: purchase.purchasedAt.toISOString(),
      })
      .select('id')
      .maybeSingle();
    
    if (error) {
      if (error.code === '23505') { // UNIQUE constraint violation
        duplicates++;
      } else {
        errors.push({
          rowId: purchase.sourceRowId,
          reason: error.message,
          rawRow: rows.find(r => r.externalId === purchase.sourceRowId)!,
        });
      }
    } else {
      inserted++;
    }
  }
  
  return { inserted, duplicates, errors };
}

export async function applyWaivers(personId: string, purchaseId: string): Promise<void> {
  // Stub for Phase 5; not implemented here
}
```

- [ ] **Step 2: Verify tsc**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add lib/purchase/interface.ts
git commit -m "feat(purchase): implement full ingestPurchases with matching and is_student derivation"
```

---

### Task 6: Add Purchase Management UI Page (Admin View)

**Files:**
- Create: `app/admin/purchases/page.tsx`

**Interfaces:**
- Consumes: `XlsxUploader` component, `requireAdmin()`
- Produces: Admin page listing recent purchases and upload UI

- [ ] **Step 1: Create admin purchases page**

```typescript
// app/admin/purchases/page.tsx
import { requireAdmin, UnauthorizedError } from '@/lib/auth/require-admin';
import { redirect } from 'next/navigation';
import { createAdminClient } from '@/lib/supabase/admin';
import { XlsxUploader } from '@/components/purchase/xlsx-uploader';

export const dynamic = 'force-dynamic';

export default async function AdminPurchasesPage() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect('/login');
    throw error;
  }
  
  const admin = createAdminClient();
  const { data: purchases } = await admin
    .from('purchase')
    .select('id, person_id, product_id, source, purchased_at, match_status')
    .order('purchased_at', { ascending: false })
    .limit(20);
  
  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Purchase Management</h1>
      
      <div className="mt-8 rounded-lg border p-4">
        <h2 className="font-semibold">Upload XLSX</h2>
        <p className="text-sm text-muted-foreground">
          Upload an XLSX file with columns: name, email, cid, member_type, product_name, purchased_at
        </p>
        <div className="mt-4">
          <XlsxUploader />
        </div>
      </div>
      
      <div className="mt-8">
        <h2 className="font-semibold">Recent Purchases ({purchases?.length || 0})</h2>
        {purchases && purchases.length > 0 ? (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2">Source</th>
                <th className="text-left py-2">Status</th>
                <th className="text-left py-2">Purchased</th>
              </tr>
            </thead>
            <tbody>
              {purchases.map((p) => (
                <tr key={p.id} className="border-b">
                  <td className="py-2">{p.source}</td>
                  <td className="py-2">{p.match_status}</td>
                  <td className="py-2">{new Date(p.purchased_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">No purchases yet.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify tsc and build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: No errors, `/admin/purchases` listed as dynamic route.

- [ ] **Step 3: Commit**

```bash
git add app/admin/purchases/
git commit -m "feat(purchase): add admin purchases management page"
```

---

## Verification Checklist (Before Marking Complete)

- [ ] All 6 tasks committed and pushed
- [ ] Stub PlutoClient compiles and throws its "not yet implemented" error when called (confirms the seam exists without pretending to integrate)
- [ ] XLSX upload tested with a sample file
- [ ] Idempotency verified: re-uploading same XLSX creates zero new rows
- [ ] is_student derivation verified: "Student" → true, all others → false
- [ ] Identity matching verified: CID match works, email match works, unmatched rows created with `person_id = null`
- [ ] TypeScript, ESLint, and `npm run build` all pass
- [ ] `/admin/purchases` page loads and requireAdmin() gates it

---

## Execution

**Plan complete.** Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — You execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

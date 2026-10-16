import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Supabase-js's .ilike() passes the pattern straight through to Postgres'
// ILIKE, which treats "_" and "%" as single-char/multi-char wildcards. For
// callers that want a case-insensitive *exact* match (e.g. email lookups),
// escape those characters first so e.g. "j_smith@gmail.com" doesn't match
// an existing "j.smith@gmail.com".
export function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// Imperial CIDs are 8 digits. Excel commonly stores a Student ID/CID
// column as a numeric cell type, which silently drops a leading zero
// (e.g. the real CID "02665790" round-trips as the number 2665790).
// Zero-padding any purely-numeric, under-length CID-like value back to
// 8 digits -- applied wherever a CID is parsed, stored, or compared --
// means a future re-export that happens to lose the zero doesn't quietly
// stop matching rows that used to match. A non-numeric or already
// 8+-digit value is returned unchanged (nothing to reconcile).
export function normalizeCid(raw: string): string {
  const trimmed = raw.trim()
  return /^\d+$/.test(trimmed) && trimmed.length < 8 ? trimmed.padStart(8, "0") : trimmed
}

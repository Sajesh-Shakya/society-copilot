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

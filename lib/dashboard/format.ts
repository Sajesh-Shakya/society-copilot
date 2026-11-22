// Pure helpers for the dashboard. Money is integer pence.

export function formatPounds(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}£${pounds.toLocaleString("en-GB")}.${rem}`;
}

export type SignupBand = "green" | "amber" | "red" | "none";

export function signupBand(avg: number | null, target: number, min: number): SignupBand {
  if (avg === null) return "none";
  if (avg >= target) return "green";
  if (avg >= min) return "amber";
  return "red";
}

// Null when no priced single-session product exists: callers show counts only.
export function owedRange(sessions: number, prices: number[]): { lowPence: number; highPence: number } | null {
  if (prices.length === 0) return null;
  return { lowPence: sessions * Math.min(...prices), highPence: sessions * Math.max(...prices) };
}

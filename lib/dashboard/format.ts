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

// "10/11 7:00 PM" (dd/mm h:mm AM/PM) in UK local time: compact, and sessions
// on the same day are told apart by start time.
export function formatSessionLabel(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return p("day") + "/" + p("month") + " " + p("hour") + ":" + p("minute") + " " + p("dayPeriod").toUpperCase();
}

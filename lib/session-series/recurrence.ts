/**
 * Pure weekly-recurrence maths for session series. Series are scheduled in
 * Europe/London wall-clock time, so a 19:00 session stays at 19:00 across
 * BST/GMT changes. No DB, no framework imports.
 */

export const SERIES_TIME_ZONE = "Europe/London";
export const MAX_OCCURRENCES = 60;

/** User-facing validation error for series input. */
export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurrenceError";
  }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

type YMD = { y: number; m: number; d: number };

function parseDate(value: string): YMD {
  const match = typeof value === "string" ? DATE_RE.exec(value) : null;
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d) {
      return { y, m, d };
    }
  }
  throw new RecurrenceError(`"${String(value)}" is not a valid date (expected YYYY-MM-DD).`);
}

function parseTime(value: string): { h: number; min: number } {
  const match = typeof value === "string" ? TIME_RE.exec(value) : null;
  if (match) {
    const h = Number(match[1]);
    const min = Number(match[2]);
    if (h <= 23 && min <= 59) return { h, min };
  }
  throw new RecurrenceError(`"${String(value)}" is not a valid time (expected HH:mm, 24-hour).`);
}

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: SERIES_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** London wall clock at an instant, expressed as ms-since-epoch as if it were UTC. */
function londonWallAsUtcMs(instantMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of londonParts.formatToParts(new Date(instantMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute);
}

const MIN = 60_000;

/**
 * The instant at which London wall clocks read `date` `time`.
 * Gap (spring forward): resolves to the instant just after the gap.
 * Overlap (autumn): resolves to the first (BST) occurrence.
 */
export function londonWallTimeToUtc(date: string, time: string): Date {
  const { y, m, d } = parseDate(date);
  const { h, min } = parseTime(time);
  const wall = Date.UTC(y, m - 1, d, h, min);
  // London is UTC+1 (BST) or UTC+0 (GMT). Try BST first so overlaps pick the first occurrence.
  for (const offsetMin of [60, 0]) {
    const candidate = wall - offsetMin * MIN;
    if (londonWallAsUtcMs(candidate) === wall) return new Date(candidate);
  }
  // Neither offset round-trips: the wall time falls in the spring-forward gap.
  // Interpreting it with the pre-gap (GMT) offset lands just after the gap.
  return new Date(wall);
}

function addDays({ y, m, d }: YMD, days: number): YMD {
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
}

const key = ({ y, m, d }: YMD) => y * 10_000 + m * 100 + d;
const fmt = ({ y, m, d }: YMD) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

export function weeklyOccurrences(input: {
  firstDate: string;
  startTime: string;
  endTime: string;
  untilDate: string;
}): { startsAt: Date; endsAt: Date }[] {
  const first = parseDate(input.firstDate);
  const until = parseDate(input.untilDate);
  const start = parseTime(input.startTime);
  const end = parseTime(input.endTime);

  if (end.h * 60 + end.min <= start.h * 60 + start.min) {
    throw new RecurrenceError("End time must be after the start time.");
  }
  if (key(until) < key(first)) {
    throw new RecurrenceError("The series end date must be on or after the first date.");
  }

  // Bound the count arithmetically before generating anything.
  const dayDiff = Math.round(
    (Date.UTC(until.y, until.m - 1, until.d) - Date.UTC(first.y, first.m - 1, first.d)) / 86_400_000,
  );
  const count = Math.floor(dayDiff / 7) + 1;
  if (count > MAX_OCCURRENCES) {
    throw new RecurrenceError(
      `A series can have at most ${MAX_OCCURRENCES} weekly sessions (this one would have ${count}).`,
    );
  }

  const out: { startsAt: Date; endsAt: Date }[] = [];
  for (let i = 0; i < count; i++) {
    const date = fmt(addDays(first, i * 7));
    out.push({
      startsAt: londonWallTimeToUtc(date, input.startTime),
      endsAt: londonWallTimeToUtc(date, input.endTime),
    });
  }
  return out;
}

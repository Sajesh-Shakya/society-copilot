import { z } from "zod";

export const END_BEFORE_START_MESSAGE = "End time must be after the start time.";

// Optional end instant: omitted, null or "" means "no end time". A provided
// value must be an ISO datetime with offset (browser forms convert
// datetime-local to an instant before sending, like startsAt).
export const optionalEndsAtSchema = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  z.string().datetime({ offset: true }).optional()
);

export function endsAfterStart(v: { startsAt: string; endsAt?: string }): boolean {
  if (!v.endsAt) return true;
  const start = new Date(v.startsAt).getTime();
  const end = new Date(v.endsAt).getTime();
  if (Number.isNaN(start)) return true; // startsAt's own validation handles this
  return end > start;
}

export const endsAfterStartRefinement = {
  message: END_BEFORE_START_MESSAGE,
  path: ["endsAt"],
};

// eActivities' EventEnd may be missing or junk: anything unparseable or not
// after the start becomes null instead of failing session creation.
export function normalizeEventEnd(startsAt: string, eventEnd: string | null | undefined): string | null {
  if (!eventEnd) return null;
  const end = new Date(eventEnd).getTime();
  const start = new Date(startsAt).getTime();
  if (Number.isNaN(end) || Number.isNaN(start) || end <= start) return null;
  return new Date(end).toISOString();
}

// Header text: "start" alone, or "start – end" (end time only when it falls
// on the same local day, full date-time otherwise).
export function formatSessionTimes(startsAt: string, endsAt: string | null): string {
  const start = new Date(startsAt);
  if (!endsAt) return start.toLocaleString();
  const end = new Date(endsAt);
  const sameDay = start.toDateString() === end.toDateString();
  return `${start.toLocaleString()} – ${sameDay ? end.toLocaleTimeString() : end.toLocaleString()}`;
}

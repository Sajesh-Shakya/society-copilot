const HOUR_MS = 60 * 60 * 1000;

// True when `now` lies in [startsAt - 1h, endsAt + 1h] (inclusive). A null
// endsAt is treated as startsAt + 2h. Cancelled sessions are never in window.
export function isInPrefetchWindow(args: {
  startsAt: Date;
  endsAt: Date | null;
  cancelledAt: Date | null;
  now: Date;
}): boolean {
  const { startsAt, endsAt, cancelledAt, now } = args;
  if (cancelledAt) return false;
  const end = endsAt ?? new Date(startsAt.getTime() + 2 * HOUR_MS);
  const t = now.getTime();
  return t >= startsAt.getTime() - HOUR_MS && t <= end.getTime() + HOUR_MS;
}

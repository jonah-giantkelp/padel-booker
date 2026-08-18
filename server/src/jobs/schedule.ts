/**
 * When to start a booking job: the moment the target date is released
 * (bookingWindowDays before it, at releaseTime local time), minus a warmup so
 * the browser is already past the Cloudflare gate when slots drop. If that
 * moment has already passed (date is inside the window), fire immediately.
 */
export function computeFireAt(
  date: string,
  opts: { releaseTime: string; bookingWindowDays: number; warmupMinutes: number },
  now: Date = new Date()
): Date {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  const tm = opts.releaseTime.match(/^(\d{1,2}):(\d{2})$/);
  if (!tm) throw new Error(`releaseTime must be HH:MM, got "${opts.releaseTime}"`);

  const fireAt = new Date(
    Number(dm[1]),
    Number(dm[2]) - 1,
    Number(dm[3]) - opts.bookingWindowDays,
    Number(tm[1]),
    Number(tm[2]) - opts.warmupMinutes,
    0,
    0
  );
  return fireAt > now ? fireAt : now;
}

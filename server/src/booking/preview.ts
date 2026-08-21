import { config, previewProfileDir } from "../config";
import { computeFireAt } from "../jobs/schedule";
import { CourtType } from "../jobs/types";
import { log } from "../log";
import { extractSlots, hasAvailabilityTable, matchesCourt, slotHour } from "./availability";
import { launchBrowser } from "./browser";
import { gotoThroughGate } from "./turnstile";

export interface AvailabilityPreview {
  date: string;
  venue: string;
  released: boolean;
  /** true = the date's release moment is still in the future (no data exists
   * yet, so !released is expected). false + !released = a live check ran but
   * found no availability table (site closed, or gate/scrape failed). */
  scheduled: boolean;
  checkedAt: string;
  slots: Array<{ hour: number; type: CourtType; court: string; price: string | null }>;
}

// Background refreshes cost a Cloudflare gate pass (potentially a 2captcha
// solve), so the scheduled refresher re-checks a viewed date at most once a
// day. A cached value is served however old until then; queue-time validation
// (getAvailabilityPreview with maxAgeMs) is the only thing that forces a
// fresher check, and that's a rare, user-initiated action.
const DAILY_MS = 24 * 60 * 60_000;
// A date stays eligible for the daily refresh this long after last being viewed.
const RECENT_WINDOW_MS = 24 * 60 * 60_000;

interface CacheEntry {
  checkedAtMs: number;
  value: AvailabilityPreview;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<AvailabilityPreview>>();
const lastRequested = new Map<string, number>();
// The preview profile dir supports exactly one Chrome at a time, so all loads
// (from requests and the refresher alike) are chained through this promise.
let browserChain: Promise<unknown> = Promise.resolve();

function refresh(date: string, venue: string): Promise<AvailabilityPreview> {
  const key = `${venue}:${date}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = browserChain
    .catch(() => {})
    .then(() => loadPreview(date, venue))
    .then((value) => {
      // Only cache a confident answer: a released read (real data) or a
      // scheduled/future date (won't change until release). A live check that
      // came back with no table is treated as a soft failure and NOT cached,
      // so the next view retries rather than showing a stale "unavailable" for
      // a day.
      if (value.released || value.scheduled) cache.set(key, { checkedAtMs: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(key));
  browserChain = task.catch(() => {});
  pending.set(key, task);
  return task;
}

/**
 * Cached availability. A cached value is always returned immediately, however
 * old — the UI never waits on (or pays for) a Chrome launch. Only a cache miss
 * triggers a live check. Pass maxAgeMs to insist on freshness: used at
 * queue time to validate against booking races, and the only path (besides the
 * once-a-day refresher) that will spend a gate pass.
 */
export async function getAvailabilityPreview(
  date: string,
  venue: string,
  opts: { maxAgeMs?: number } = {}
): Promise<AvailabilityPreview> {
  const maxAgeMs = opts.maxAgeMs ?? Number.POSITIVE_INFINITY;
  const key = `${venue}:${date}`;
  lastRequested.set(key, Date.now());
  const cached = cache.get(key);
  if (cached && Date.now() - cached.checkedAtMs <= maxAgeMs) return cached.value;
  return refresh(date, venue);
}

/**
 * Re-check recently-viewed dates on a schedule so the calendar drifts back
 * towards reality — but at most once per day per date, since each check costs
 * a Cloudflare gate pass / 2captcha credit.
 */
export function startPreviewRefresher(): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, requestedAt] of lastRequested) {
      if (now - requestedAt > RECENT_WINDOW_MS) {
        lastRequested.delete(key);
        continue;
      }
      const cached = cache.get(key);
      if (cached && now - cached.checkedAtMs < DAILY_MS) continue;
      const [venue, date] = key.split(":");
      void refresh(date, venue).catch((err) =>
        log(`Scheduled availability refresh failed for ${key}:`, err.message)
      );
    }
  }, config.previewRefreshSeconds * 1000);
  log(`Availability refresher started (checks every ${config.previewRefreshSeconds}s, refreshes each date ≤1×/day)`);
  return () => clearInterval(timer);
}

async function loadPreview(date: string, venue: string): Promise<AvailabilityPreview> {
  const checkedAt = new Date().toISOString();
  // A future release needs no browser check: its exact availability does not
  // exist yet, so the UI allows choosing a desired time and queues the job.
  if (computeFireAt(date, config).getTime() > Date.now() + 1000) {
    return { date, venue, released: false, scheduled: true, checkedAt, slots: [] };
  }

  const url = `${config.baseUrl}/book/courts/${venue}/${date}`;
  const { browser, page } = await launchBrowser(previewProfileDir());
  try {
    await gotoThroughGate(page, url);
    if (!(await hasAvailabilityTable(page))) {
      return { date, venue, released: false, scheduled: false, checkedAt, slots: [] };
    }
    const availability = await extractSlots(page);
    const slots: AvailabilityPreview["slots"] = [];
    for (const slot of availability.slots) {
      if (!slot.available) continue;
      const hour = slotHour(slot);
      if (hour === null) continue;
      const type: CourtType | null = matchesCourt(slot, "padel") ? "padel" : matchesCourt(slot, "tennis") ? "tennis" : null;
      if (type) slots.push({ hour, type, court: slot.court, price: slot.price });
    }
    return { date, venue, released: true, scheduled: false, checkedAt, slots };
  } finally {
    await browser.close();
  }
}

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
  checkedAt: string;
  slots: Array<{ hour: number; type: CourtType; court: string; price: string | null }>;
}

const TTL_RELEASED_MS = 90_000;
const TTL_UNRELEASED_MS = 30_000;
// Keep refreshing a date this long after the UI last asked about it.
const RECENT_WINDOW_MS = 15 * 60_000;

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

const ttlFor = (value: AvailabilityPreview) =>
  value.released ? TTL_RELEASED_MS : TTL_UNRELEASED_MS;

function refresh(date: string, venue: string): Promise<AvailabilityPreview> {
  const key = `${venue}:${date}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const task = browserChain
    .catch(() => {})
    .then(() => loadPreview(date, venue))
    .then((value) => {
      cache.set(key, { checkedAtMs: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(key));
  browserChain = task.catch(() => {});
  pending.set(key, task);
  return task;
}

/**
 * Cached availability. By default a cached value is returned immediately —
 * however stale — with a background refresh kicked off past its TTL, so the
 * UI never waits on a Chrome launch. Pass maxAgeMs to insist on freshness
 * (used when queueing a job, to validate against booking races).
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
  if (cached && Date.now() - cached.checkedAtMs <= maxAgeMs) {
    if (Date.now() - cached.checkedAtMs > ttlFor(cached.value)) {
      void refresh(date, venue).catch((err) =>
        log("Background availability refresh failed:", err.message)
      );
    }
    return cached.value;
  }
  return refresh(date, venue);
}

/**
 * Keep recently-viewed dates fresh on a schedule, so the calendar reflects
 * other people's bookings without a slow check on every click.
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
      if (cached && now - cached.checkedAtMs <= ttlFor(cached.value)) continue;
      const [venue, date] = key.split(":");
      void refresh(date, venue).catch((err) =>
        log(`Scheduled availability refresh failed for ${key}:`, err.message)
      );
    }
  }, config.previewRefreshSeconds * 1000);
  log(`Availability refresher started (every ${config.previewRefreshSeconds}s)`);
  return () => clearInterval(timer);
}

async function loadPreview(date: string, venue: string): Promise<AvailabilityPreview> {
  const checkedAt = new Date().toISOString();
  // A future release needs no browser check: its exact availability does not
  // exist yet, so the UI allows choosing a desired time and queues the job.
  if (computeFireAt(date, config).getTime() > Date.now() + 1000) {
    return { date, venue, released: false, checkedAt, slots: [] };
  }

  const url = `${config.baseUrl}/book/courts/${venue}/${date}`;
  const { browser, page } = await launchBrowser(previewProfileDir());
  try {
    await gotoThroughGate(page, url);
    if (!(await hasAvailabilityTable(page))) return { date, venue, released: false, checkedAt, slots: [] };
    const availability = await extractSlots(page);
    const slots: AvailabilityPreview["slots"] = [];
    for (const slot of availability.slots) {
      if (!slot.available) continue;
      const hour = slotHour(slot);
      if (hour === null) continue;
      const type: CourtType | null = matchesCourt(slot, "padel") ? "padel" : matchesCourt(slot, "tennis") ? "tennis" : null;
      if (type) slots.push({ hour, type, court: slot.court, price: slot.price });
    }
    return { date, venue, released: true, checkedAt, slots };
  } finally {
    await browser.close();
  }
}

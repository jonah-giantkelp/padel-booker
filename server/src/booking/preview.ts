import { config, previewProfileDir } from "../config";
import { computeFireAt } from "../jobs/schedule";
import { CourtType } from "../jobs/types";
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

const cache = new Map<string, { expiresAt: number; value: AvailabilityPreview }>();
const pending = new Map<string, Promise<AvailabilityPreview>>();

export async function getAvailabilityPreview(date: string, venue: string): Promise<AvailabilityPreview> {
  const key = `${venue}:${date}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const existing = pending.get(key);
  if (existing) return existing;

  const task = loadPreview(date, venue).finally(() => pending.delete(key));
  pending.set(key, task);
  const value = await task;
  cache.set(key, { expiresAt: Date.now() + (value.released ? 90_000 : 30_000), value });
  return value;
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

import type { Page } from "puppeteer";
import { CourtType } from "../jobs/types";

export interface Slot {
  time: string;
  court: string;
  available: boolean;
  price: string | null;
  concession: string | null;
  token: string | null;
}

export interface Availability {
  title: string;
  heading: string;
  date: string;
  venue: string;
  slotCount: number;
  availableCount: number;
  slots: Slot[];
}

/** Is the availability table rendered (vs the "not available to book yet" notice)? */
export async function hasAvailabilityTable(page: Page): Promise<boolean> {
  return page.evaluate(() => !!document.querySelector(".availability table"));
}

export async function closedMessage(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector(".availability p.closed")?.textContent?.trim() || null
  );
}

export async function extractSlots(page: Page): Promise<Availability> {
  return page.evaluate(() => {
    // Courtside renders availability as a <table> inside .availability: each row
    // is a time (th.time) with one label.court per court. An available court has
    // an <input.bookable> carrying the booking token + data-price; a booked one
    // has a disabled input and a "booked" button.
    const slots: {
      time: string;
      court: string;
      available: boolean;
      price: string | null;
      concession: string | null;
      token: string | null;
    }[] = [];
    const rows = document.querySelectorAll(".availability table tr");
    for (const row of rows) {
      const time = (row.querySelector("th.time")?.textContent || "").replace(/\s+/g, " ").trim();
      if (!time) continue;
      for (const label of row.querySelectorAll("label.court")) {
        const button = label.querySelector(".button");
        const priceEl = label.querySelector(".price");
        const priceText = (priceEl?.textContent || "").replace(/\s+/g, " ").trim();
        const name = (button?.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .replace(priceText, "")
          .trim();
        const input = label.querySelector("input");
        const available = button?.classList.contains("available") || false;
        slots.push({
          time,
          court: name,
          available,
          price: input?.getAttribute("data-price")
            ? `£${input.getAttribute("data-price")}`
            : priceText || null,
          concession: input?.getAttribute("data-concession")
            ? `£${input.getAttribute("data-concession")}`
            : null,
          token: available ? input?.getAttribute("value") || null : null
        });
      }
    }

    let availableCount = 0;
    for (const slot of slots) if (slot.available) availableCount += 1;
    const availability = document.querySelector(".availability");
    const previousDate = availability?.previousElementSibling?.querySelector(".date");
    const headingDate = document.querySelector(".heading .date");
    return {
      title: document.title,
      heading: (document.querySelector("h1")?.textContent || "").replace(/\s+/g, " ").trim(),
      date: ((previousDate?.textContent || headingDate?.textContent) || "").replace(/\s+/g, " ").trim(),
      venue: (document.querySelector(".heading .venue .name")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
      slotCount: slots.length,
      availableCount,
      slots
    };
  });
}

// ---------------------------------------------------------------------------
// Pure matching helpers
// ---------------------------------------------------------------------------

/** "7pm" / "7:00pm" / "19:00" / "19" -> hour 0-23 (slots are on the hour). */
export function parseHour(input: string): number {
  const m = String(input)
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error(`Cannot parse time "${input}" — use e.g. "7pm" or "19:00"`);
  let hour = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  if (minutes !== 0) throw new Error(`Slots start on the hour; got "${input}"`);
  if (m[3] === "pm" && hour !== 12) hour += 12;
  if (m[3] === "am" && hour === 12) hour = 0;
  if (hour > 23) throw new Error(`Bad hour in "${input}"`);
  return hour;
}

/** Slot token is "<venueId>_<courtId>_<date>_<HH:MM>" — read the hour back out. */
function tokenHour(token: string | null): number | null {
  const m = (token || "").match(/_(\d{2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) : null;
}

/** "7am" / "12pm" row labels -> hour. */
function rowLabelHour(label: string): number | null {
  const m = (label || "").trim().toLowerCase().match(/^(\d{1,2})(am|pm)$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  if (m[2] === "pm" && hour !== 12) hour += 12;
  if (m[2] === "am" && hour === 12) hour = 0;
  return hour;
}

export function slotHour(slot: Slot): number | null {
  const fromToken = tokenHour(slot.token);
  return fromToken !== null ? fromToken : rowLabelHour(slot.time);
}

/** Court names on the site look like "Padel court 1" / "Tennis court 3". */
export function matchesCourt(slot: Slot, type: CourtType, courtNumber?: number): boolean {
  const name = slot.court.toLowerCase();
  if (courtNumber !== undefined) return name === `${type} court ${courtNumber}`;
  return name.startsWith(type);
}

export function findSlot(
  slots: Slot[],
  criteria: { hour: number; type: CourtType; courtNumber?: number }
): { match: Slot | null; candidates: Slot[] } {
  const candidates = slots.filter(
    (s) => slotHour(s) === criteria.hour && matchesCourt(s, criteria.type, criteria.courtNumber)
  );
  return { match: candidates.find((s) => s.available) || null, candidates };
}

/** Human-readable "no slot" error with same-day alternatives. */
export function noSlotError(
  availability: Availability,
  criteria: { hour: number; type: CourtType; courtNumber?: number },
  candidates: Slot[]
): Error {
  const wanted = `${criteria.type}${criteria.courtNumber ? ` court ${criteria.courtNumber}` : ""} at ${criteria.hour}:00`;
  const alternatives = availability.slots
    .filter((s) => s.available && matchesCourt(s, criteria.type))
    .map((s) => `${s.time} ${s.court} ${s.price}`);
  const why = candidates.length
    ? `all ${candidates.length} matching court(s) are booked`
    : "no such court/time on this page";
  return new Error(
    `No available slot for ${wanted} (${why}). ` +
      (alternatives.length
        ? `Other available ${criteria.type} slots that day: ${alternatives.join("; ")}`
        : `No ${criteria.type} availability at all that day.`)
  );
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { findSlot, matchesCourt, parseHour, slotHour, Slot } from "./availability";

test("parseHour handles common formats", () => {
  assert.equal(parseHour("7pm"), 19);
  assert.equal(parseHour("7:00pm"), 19);
  assert.equal(parseHour("19:00"), 19);
  assert.equal(parseHour("19"), 19);
  assert.equal(parseHour("7am"), 7);
  assert.equal(parseHour("12pm"), 12);
  assert.equal(parseHour("12am"), 0);
  assert.throws(() => parseHour("7:30pm"));
  assert.throws(() => parseHour("banana"));
  assert.throws(() => parseHour("25:00"));
});

const slot = (time: string, court: string, available: boolean, token: string | null): Slot => ({
  time,
  court,
  available,
  price: available ? "£24" : "booked",
  concession: null,
  token
});

// Mirrors the real page: tokens are <venueId>_<courtId>_<date>_<HH:MM>.
const SLOTS: Slot[] = [
  slot("7am", "Padel court 1", true, "251_243_2026-08-25_07:00"),
  slot("7am", "Tennis court 1", false, null),
  slot("8am", "Padel court 1", true, "251_243_2026-08-25_08:00"),
  slot("8am", "Tennis court 1", false, null),
  slot("8am", "Tennis court 3", true, "251_156_2026-08-25_08:00"),
  slot("7pm", "Padel court 1", false, null)
];

test("slotHour prefers the token, falls back to the row label", () => {
  assert.equal(slotHour(SLOTS[0]), 7);
  assert.equal(slotHour(SLOTS[1]), 7); // no token -> "7am" label
  assert.equal(slotHour(SLOTS[5]), 19); // "7pm" label
});

test("matchesCourt by type and by specific number", () => {
  assert.ok(matchesCourt(SLOTS[0], "padel"));
  assert.ok(!matchesCourt(SLOTS[0], "tennis"));
  assert.ok(matchesCourt(SLOTS[4], "tennis", 3));
  assert.ok(!matchesCourt(SLOTS[4], "tennis", 1));
});

test("findSlot picks the first available matching court", () => {
  const hit = findSlot(SLOTS, { hour: 8, type: "tennis" });
  assert.equal(hit.match?.court, "Tennis court 3");

  const specificBooked = findSlot(SLOTS, { hour: 8, type: "tennis", courtNumber: 1 });
  assert.equal(specificBooked.match, null);
  assert.equal(specificBooked.candidates.length, 1);

  const evening = findSlot(SLOTS, { hour: 19, type: "padel" });
  assert.equal(evening.match, null);
  assert.equal(evening.candidates.length, 1);

  const nothing = findSlot(SLOTS, { hour: 7, type: "tennis", courtNumber: 9 });
  assert.equal(nothing.candidates.length, 0);
});

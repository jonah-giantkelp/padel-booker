process.env.TZ = "Europe/London";

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFireAt } from "./schedule";

const OPTS = { releaseTime: "00:00", bookingWindowDays: 7, warmupMinutes: 2 };

test("fires warmup minutes before release, 7 days ahead", () => {
  const now = new Date(2026, 7, 18, 12, 0, 0); // 2026-08-18 12:00 London
  const fireAt = computeFireAt("2026-08-26", OPTS, now);
  // Release: 2026-08-19 00:00 -> fire 2026-08-18 23:58
  assert.equal(fireAt.getFullYear(), 2026);
  assert.equal(fireAt.getMonth(), 7);
  assert.equal(fireAt.getDate(), 18);
  assert.equal(fireAt.getHours(), 23);
  assert.equal(fireAt.getMinutes(), 58);
});

test("a date already inside the window fires immediately", () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);
  const fireAt = computeFireAt("2026-08-20", OPTS, now);
  assert.equal(fireAt.getTime(), now.getTime());
});

test("respects a non-midnight release time", () => {
  const now = new Date(2026, 7, 18, 12, 0, 0);
  const fireAt = computeFireAt("2026-08-26", { ...OPTS, releaseTime: "08:00" }, now);
  assert.equal(fireAt.getDate(), 19);
  assert.equal(fireAt.getHours(), 7);
  assert.equal(fireAt.getMinutes(), 58);
});

test("rejects malformed input", () => {
  assert.throws(() => computeFireAt("26-08-2026", OPTS));
  assert.throws(() => computeFireAt("2026-08-26", { ...OPTS, releaseTime: "midnight" }));
});

/** One-off: print the first available slots over the next few days. */
import { getAvailabilityPreview } from "../booking/preview";
import { config } from "../config";
import { log } from "../log";

async function main() {
  const venue = process.argv[2] || config.venues[0];
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    try {
      const p = await getAvailabilityPreview(date, venue, { maxAgeMs: 0 });
      const summary = p.released
        ? p.slots.map((s) => `${s.hour}:00 ${s.type}${/court (\d)/i.exec(s.court)?.[1] ? " #" + /court (\d)/i.exec(s.court)![1] : ""}`).join(", ") || "(released, none free)"
        : p.scheduled ? "(not released yet)" : "(no table / check failed)";
      log(`${date} [${venue}]: ${summary}`);
    } catch (err) {
      log(`${date} [${venue}]: ERROR ${err instanceof Error ? err.message : err}`);
    }
  }
  process.exit(0);
}
main();

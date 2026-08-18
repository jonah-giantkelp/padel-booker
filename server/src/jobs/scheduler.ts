import { config } from "../config";
import { log } from "../log";
import { runProbeJob } from "../booking/probe";
import { runBookingJob } from "../booking/run";
import { computeFireAt } from "./schedule";
import { JobStore } from "./store";
import { BookingJob } from "./types";

const TICK_MS = 15000;

/** YYYY-MM-DD (local TZ = Europe/London) for the first date outside the booking window. */
function nextUnreleasedDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + config.bookingWindowDays + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * AUTO_PROBE: make sure a probe job exists for the next not-yet-bookable date.
 * Runs every tick; once that date has a probe (whatever its status), it's a
 * no-op — so one probe per date, a fresh one appearing each day.
 */
async function ensureAutoProbe(store: JobStore): Promise<void> {
  const date = nextUnreleasedDate();
  if (store.list().some((j) => j.kind === "probe" && j.date === date)) return;
  const job = await store.add({
    kind: "probe",
    venue: config.venues[0],
    date,
    fireAt: computeFireAt(date, config).toISOString(),
    status: "scheduled"
  });
  log(`Auto-probe: queued ${job.id} for ${date} (fires ${job.fireAt})`);
}

/**
 * Polls the store and executes due jobs (fireAt <= now).
 *
 * Booking jobs run one at a time — a booking takes well under a minute and a
 * single Chrome keeps the memory footprint sane on a small Railway instance.
 * Probe jobs can poll for hours, so they run concurrently (each with its own
 * Chrome profile) and never hold up a booking.
 */
export function startScheduler(store: JobStore): () => void {
  let bookingBusy = false;
  const activeProbes = new Set<string>();

  const runOne = async (job: BookingJob) => {
    log(`Scheduler: firing ${job.kind} job ${job.id} (${job.date} at ${job.venue})`);
    await store.update(job.id, { status: "running", startedAt: new Date().toISOString(), error: undefined });
    try {
      const result = job.kind === "probe" ? await runProbeJob(job) : await runBookingJob(job);
      await store.update(job.id, {
        status: "success",
        result,
        finishedAt: new Date().toISOString()
      });
      log(`Scheduler: job ${job.id} succeeded`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await store.update(job.id, { status: "failed", error: message, finishedAt: new Date().toISOString() });
      log(`Scheduler: job ${job.id} FAILED — ${message}`);
    }
  };

  const due = () =>
    store.list().filter((j) => j.status === "scheduled" && new Date(j.fireAt) <= new Date());

  const tick = async () => {
    if (config.autoProbe) {
      await ensureAutoProbe(store).catch((err) => log("Auto-probe error:", err.message));
    }

    // Probes: launch every due one, fire-and-forget.
    for (const probe of due().filter((j) => j.kind === "probe")) {
      if (activeProbes.has(probe.id)) continue;
      activeProbes.add(probe.id);
      void runOne(probe).finally(() => activeProbes.delete(probe.id));
    }

    // Bookings: strictly one at a time.
    if (bookingBusy) return;
    bookingBusy = true;
    try {
      for (;;) {
        const next = due().find((j) => j.kind !== "probe");
        if (!next) break;
        await runOne(next);
      }
    } catch (err) {
      log("Scheduler tick error:", err instanceof Error ? err.message : err);
    } finally {
      bookingBusy = false;
    }
  };

  const timer = setInterval(tick, TICK_MS);
  void tick();
  log(`Scheduler started (tick every ${TICK_MS / 1000}s)`);
  return () => clearInterval(timer);
}

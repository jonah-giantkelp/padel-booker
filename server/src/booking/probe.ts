import fs from "node:fs/promises";
import path from "node:path";
import { config, probeProfileDir } from "../config";
import { BookingJob, ProbeResult } from "../jobs/types";
import { delay, log } from "../log";
import { closedMessage, extractSlots, hasAvailabilityTable } from "./availability";
import { launchBrowser } from "./browser";
import { gotoThroughGate } from "./turnstile";

/**
 * Release-time probe: reload the date's page (slow cadence, long deadline)
 * until it becomes bookable, and report the window in which it flipped. Every
 * poll is also appended to data/release-<date>.log for a durable trace.
 */
export async function runProbeJob(job: BookingJob): Promise<ProbeResult> {
  const url = `${config.baseUrl}/book/courts/${job.venue}/${job.date}`;
  const logFile = path.join(config.dataDir, `release-${job.date}.log`);
  const line = async (msg: string) => {
    log(`Probe ${job.id}: ${msg}`);
    await fs.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`).catch(() => {});
  };

  const { browser, page } = await launchBrowser(probeProfileDir(job.id));
  try {
    await line(`watching ${url} every ${config.probePollMinutes}min`);
    const deadline = Date.now() + config.probeMaxHours * 3600000;
    let lastClosedAt: string | null = null;

    for (;;) {
      await gotoThroughGate(page, url);
      if (await hasAvailabilityTable(page)) {
        const openedAt = new Date().toISOString();
        const data = await extractSlots(page);
        await line(
          `OPEN — ${job.date} is bookable (${data.availableCount}/${data.slotCount} available). ` +
            (lastClosedAt
              ? `Released between ${lastClosedAt} and ${openedAt}.`
              : "Was already open on the first check.")
        );
        return {
          kind: "probe",
          lastClosedAt,
          openedAt,
          availableCount: data.availableCount,
          slotCount: data.slotCount
        };
      }

      lastClosedAt = new Date().toISOString();
      await line(`closed — "${(await closedMessage(page)) || "no availability table"}"`);
      if (Date.now() > deadline) {
        throw new Error(`Still closed after ${config.probeMaxHours}h of polling`);
      }
      await delay(config.probePollMinutes * 60000);
    }
  } finally {
    await browser.close();
    // One-shot profile; don't let them accumulate on the volume.
    await fs.rm(probeProfileDir(job.id), { recursive: true, force: true }).catch(() => {});
  }
}

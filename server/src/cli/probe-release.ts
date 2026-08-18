/**
 * Probe (or watch) when a date becomes bookable — used to pin down the
 * still-unknown release time.
 *
 *   npm run cli:probe-release -- --date 2026-08-27 [--once] [--interval 5] [--venue slug]
 *
 * Without --once it polls until the date opens, logging a timestamped line per
 * poll to data/release-<date>.log; the flip time lands between the last
 * "closed" line and the "OPEN" line. Set RELEASE_TIME in .env accordingly.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { closedMessage, extractSlots, hasAvailabilityTable } from "../booking/availability";
import { launchBrowser } from "../booking/browser";
import { gotoThroughGate } from "../booking/turnstile";
import { config } from "../config";
import { delay, log } from "../log";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const date = get("--date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Usage: npm run cli:probe-release -- --date YYYY-MM-DD [--once] [--interval mins]");
  }
  const venue = get("--venue") || config.venues[0];
  const once = argv.includes("--once");
  const intervalMin = Number(get("--interval") || 5);
  const url = `${config.baseUrl}/book/courts/${venue}/${date}`;

  await fs.mkdir(config.dataDir, { recursive: true });
  const logFile = path.join(config.dataDir, `release-${date}.log`);
  const line = async (msg: string) => {
    log(msg);
    await fs.appendFile(logFile, `${new Date().toISOString()} ${msg}\n`);
  };

  const { browser, page } = await launchBrowser(path.join(config.dataDir, "profile-probe"));
  try {
    await line(`Watching ${url} every ${intervalMin}min`);
    for (;;) {
      await gotoThroughGate(page, url);
      if (await hasAvailabilityTable(page)) {
        const data = await extractSlots(page);
        await line(`OPEN — ${date} is bookable: ${data.availableCount}/${data.slotCount} slots available`);
        await line("Release time is between the previous line and this one. Set RELEASE_TIME in .env.");
        return;
      }
      await line(`closed — "${(await closedMessage(page)) || "no availability table"}"`);
      if (once) return;
      await delay(intervalMin * 60000);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  log("FAILED:", err.message);
  process.exitCode = 1;
});

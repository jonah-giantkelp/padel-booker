/**
 * CLI booker (same engine the scheduler uses).
 *
 *   npm run cli:book -- --date 2026-08-25 --time 7am --type padel \
 *     [--court N] [--venue slug] [--stop-at basket|details|payment] \
 *     [--name "J Smith" --email j@x.com --mobile 07700900000] \
 *     [--dob YYYY-MM-DD --gender f|m|n --other-tel 020...]
 *
 * Defaults to --stop-at basket so it never submits anything without details.
 */
import { randomUUID } from "node:crypto";
import { runBookingJob } from "../booking/run";
import { config } from "../config";
import { BookingDetails, BookingJob, CourtType, StopAt } from "../jobs/types";
import { parseHour } from "../booking/availability";
import { log } from "../log";

function parseArgs(argv: string[]): BookingJob {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const date = get("--date");
  const time = get("--time");
  const type = get("--type") as CourtType;
  const dob = get("--dob") || "";
  const gender = get("--gender") || "";
  if (!date || !time || !type) {
    throw new Error(
      "Usage: npm run cli:book -- --date YYYY-MM-DD --time 7pm --type padel|tennis " +
        "[--court N] [--venue slug] [--stop-at basket|details|payment] " +
        "[--name ... --email ... --mobile ...] " +
        "[--dob YYYY-MM-DD --gender f|m|n --other-tel ...]"
    );
  }
  if (get("--stop-at") === "payment") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new Error("--dob YYYY-MM-DD is required when --stop-at payment");
    }
    if (!["f", "m", "n"].includes(gender)) {
      throw new Error("--gender must be f, m or n when --stop-at payment");
    }
  }
  return {
    id: `cli-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    kind: "booking",
    venue: get("--venue") || config.venues[0],
    date,
    hour: parseHour(time),
    courtType: type,
    courtNumber: get("--court") ? Number(get("--court")) : undefined,
    details: {
      fullName: get("--name") || "",
      email: get("--email") || "",
      mobile: get("--mobile") || "",
      otherTel: get("--other-tel"),
      dob,
      gender: gender as BookingDetails["gender"]
    },
    stopAt: (get("--stop-at") as StopAt) || "basket",
    fireAt: new Date().toISOString(),
    status: "running"
  };
}

runBookingJob(parseArgs(process.argv.slice(2)))
  .then((result) => log("DONE", result))
  .catch((err) => {
    log("FAILED:", err.message);
    process.exitCode = 1;
  });

/**
 * CLI booker (same engine the scheduler uses).
 *
 *   npm run cli:book -- --date 2026-08-25 --time 7am --type padel \
 *     [--court N] [--venue slug] [--stop-at basket|details|payment|card|paid] \
 *     [--name "J Smith" --email j@x.com --mobile 07700900000] \
 *     [--dob YYYY-MM-DD --gender f|m|n --other-tel 020...]
 *
 * Defaults to --stop-at basket so it never submits anything without details.
 * --stop-at card probes the card form without entering anything. --stop-at
 * paid actually pays; the card comes from env (not argv, which leaks into
 * shell history): CARD_NUMBER, CARD_EXPIRY (MM/YY), CARD_CVC, CARD_NAME,
 * CARD_POSTCODE.
 */
import { randomUUID } from "node:crypto";
import { runBookingJob } from "../booking/run";
import { config } from "../config";
import { BookingDetails, BookingJob, CardDetails, CourtType, StopAt } from "../jobs/types";
import { parseHour } from "../booking/availability";
import { log } from "../log";

function cardFromEnv(): CardDetails {
  const need = (name: string): string => {
    const v = (process.env[name] || "").trim();
    if (!v) throw new Error(`--stop-at paid needs ${name} in the environment (see .env)`);
    return v;
  };
  const expiry = need("CARD_EXPIRY").match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!expiry) throw new Error("CARD_EXPIRY must be MM/YY");
  return {
    number: need("CARD_NUMBER").replace(/[\s-]/g, ""),
    expMonth: Number(expiry[1]),
    expYear: Number(expiry[2].length === 2 ? `20${expiry[2]}` : expiry[2]),
    cvc: need("CARD_CVC"),
    name: need("CARD_NAME"),
    postcode: need("CARD_POSTCODE").toUpperCase()
  };
}

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
        "[--court N] [--venue slug] [--stop-at basket|details|payment|card|paid] " +
        "[--name ... --email ... --mobile ...] " +
        "[--dob YYYY-MM-DD --gender f|m|n --other-tel ...]"
    );
  }
  const stopAt = get("--stop-at") || "basket";
  if (["payment", "card", "paid"].includes(stopAt)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      throw new Error(`--dob YYYY-MM-DD is required when --stop-at ${stopAt}`);
    }
    if (!["f", "m", "n"].includes(gender)) {
      throw new Error(`--gender must be f, m or n when --stop-at ${stopAt}`);
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
    stopAt: stopAt as StopAt,
    fireAt: new Date().toISOString(),
    status: "running"
  };
}

const job = parseArgs(process.argv.slice(2));
runBookingJob(job, job.stopAt === "paid" ? cardFromEnv() : undefined)
  .then((result) => log("DONE", result))
  .catch((err) => {
    log("FAILED:", err.message);
    process.exitCode = 1;
  });

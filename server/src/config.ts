// All times on the Courtside site are London times; make the process agree
// before anything constructs a Date.
process.env.TZ = process.env.TZ || "Europe/London";

import path from "node:path";
import dotenv from "dotenv";

// Repo-root .env (works from both src/ via tsx and dist/ via node).
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 8080),
  dataDir: process.env.DATA_DIR || path.join(__dirname, "..", "..", "data"),

  baseUrl: "https://tennistowerhamlets.com",
  venues: [
    "bethnal-green-gardens",
    "king-edward-memorial-park",
    "poplar-rec-ground",
    "ropemakers-field",
    "st-johns-park",
    "victoria-park",
    "wapping-gardens"
  ],

  // Bookings open this many days ahead ("up to a week in advance").
  bookingWindowDays: num(process.env.BOOKING_WINDOW_DAYS, 7),
  // What time the new day is released. TBC — the site doesn't publish it.
  // Until measured, assume midnight; override with RELEASE_TIME=HH:MM.
  releaseTime: process.env.RELEASE_TIME || "00:00",
  // Start the job this many minutes before releaseTime so the browser is
  // already through the Cloudflare gate when slots drop.
  warmupMinutes: num(process.env.WARMUP_MINUTES, 2),
  // After firing, poll the availability page this often until the day opens…
  pollSeconds: num(process.env.POLL_SECONDS, 10),
  // …giving up after this long (covers an unknown release time being late).
  maxWaitMinutes: num(process.env.MAX_WAIT_MINUTES, 60),

  // Probe jobs (release-time discovery) poll slower and for much longer —
  // they may bracket a whole night/morning.
  probePollMinutes: num(process.env.PROBE_POLL_MINUTES, 5),
  probeMaxHours: num(process.env.PROBE_MAX_HOURS, 24),

  twoCaptchaApiKey: process.env.TWO_CAPTCHA_API_KEY || "",
  headless: process.env.HEADLESS !== "false",
  puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
};

export const jobsFile = () => path.join(config.dataDir, "jobs.json");
export const profileDir = () => path.join(config.dataDir, "profile");
export const artifactsDir = (jobId: string) => path.join(config.dataDir, "artifacts", jobId);
// Probes run concurrently with bookings, so each gets its own Chrome profile.
export const probeProfileDir = (jobId: string) => path.join(config.dataDir, "profile-probe", jobId);

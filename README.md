# padel-booker

Books padel/tennis courts at **[Tennis Tower Hamlets](https://tennistowerhamlets.com)**
(Courtside), whose booking pages sit behind a Cloudflare Turnstile
"verify-human" gate.

Courts are released **7 days ahead** at a time the site doesn't publish
(**TBC** — see [Release time](#release-time)) and popular slots go fast. You
queue a booking with your details; the job fires just before the release
moment, waits for the day to open, and races the slot into the basket.

```
React (web/) ──/api──▶ Express (server/) ──▶ scheduler ──▶ puppeteer + 2captcha ──▶ tennistowerhamlets.com
                                │
                          data/jobs.json   (file-backed queue; survives restarts)
```

## How a job runs

1. At `fireAt` (= release time − `WARMUP_MINUTES`, or immediately if the date
   is already inside the window) the scheduler launches a stealth Chromium.
2. Passes the Turnstile gate — via 2captcha, or free if the persisted Chrome
   profile (`data/profile`) still has a clearance cookie.
3. Reloads the availability page every `POLL_SECONDS` until the day opens.
4. Finds the requested slot (type + hour, optionally a specific court number;
   otherwise first available). If it's taken, fails with the day's
   alternatives in the error.
5. Adds it to the basket, fills the site's "Your details" checkout form
   (name, email, mobile, phone, DOB, gender) and — depending on the job's
   "how far to go" setting — submits it and verifies that the payment page is displayed.
6. Saves a screenshot + HTML at every stage to `data/artifacts/<jobId>/`,
   viewable from the web UI.

**Payment is never automated** and no card details are stored; complete the
final payment step yourself.

## Local development

```bash
cp .env.example .env          # add your TWO_CAPTCHA_API_KEY
npm install
npm run dev:server            # API + scheduler on :8080
npm run dev:web               # Vite dev server on :5173 (proxies /api)
```

The app is login-gated. Configure `AUTH_EMAIL`, a salted scrypt
`AUTH_PASSWORD_HASH` (`<salt-hex>:<hash-hex>`), and a random `SESSION_SECRET`
in an ignored `.env.auth` file locally, and as deployment variables in Railway.
All booking and artifact API routes require a signed, HTTP-only session cookie.

On macOS also set in `.env` (the Puppeteer-bundled Chrome can download broken):

```
PUPPETEER_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

Production-style: `npm run build && npm start` serves the built React app and
the API together on `:8080`.

Tests: `npm test` (slot matching, time parsing, fire-time computation).

### CLI

```bash
# Book directly, right now (defaults to --stop-at basket):
npm run cli:book --workspace server -- --date 2026-08-25 --time 7am --type padel

# Find the release time / watch a date until it opens:
npm run cli:probe-release --workspace server -- --date 2026-08-27 --once
```

## Job inputs

`POST /api/jobs` (the web form maps 1:1):

| field | booking | probe | notes |
|-------|---------|-------|-------|
| `kind` | `"booking"` (default) | `"probe"` | |
| `date` | required | required | YYYY-MM-DD |
| `venue` | optional | optional | slug, default `bethnal-green-gardens` |
| `time` | required | – | `7pm` / `19:00`, on the hour |
| `courtType` | required | – | `padel` or `tennis` |
| `courtNumber` | optional | – | else first available |
| `stopAt` | optional | – | `basket` / `details` / `payment` (default) |
| `details.fullName/email/mobile/dob/gender` | required | – | `dob` YYYY-MM-DD, `gender` f/m/n |
| `details.otherTel` | optional | – | alternative contact number |

## Release time (probe jobs)

The site only says bookings open "up to a week in advance" — measurements so
far show the whole day drops at once, some time **before 14:00 London**.
`RELEASE_TIME` defaults to `00:00` (midnight).

To pin it down, queue a **"Find the release time" probe** (or POST
`{"kind":"probe","date":"<8+ days out>"}`). It fires just before the assumed
release, reloads the page every `PROBE_POLL_MINUTES` (default 5) for up to
`PROBE_MAX_HOURS` (default 24), and records the window in which the date
flipped from "not available to book yet" to bookable — shown in the job list
and appended to `data/release-<date>.log`. Then set `RELEASE_TIME=HH:MM`.

Set **`AUTO_PROBE=true`** to skip even the queueing: the scheduler keeps a
probe job queued for the next not-yet-bookable date, giving one release-time
measurement per night until you turn it off. Check the job list or
`data/release-*.log` each morning.

Probes run concurrently with bookings (own Chrome profile), so a long-running
probe never delays a booking job. An early `RELEASE_TIME` guess is safe —
booking jobs poll for up to `MAX_WAIT_MINUTES` after firing (raise it if the
gap could exceed an hour; tighten once the time is known).

## Deploying to Railway (git push)

The repo is Railway-ready: `railway.json` points at the `Dockerfile`
(node + Debian chromium, `TZ=Europe/London`).

1. Push this repo to GitHub; in Railway create a project → **Deploy from
   GitHub repo**. Every push to the default branch deploys.
2. **Variables**: set `TWO_CAPTCHA_API_KEY` (and `RELEASE_TIME` once known).
3. **Volume**: attach one mounted at `/app/data` — it holds the job queue,
   Chrome profile and artifacts; without it every deploy wipes the queue.
4. Generate a domain (Settings → Networking). Railway injects `PORT`
   automatically.

Note: the app has no auth — anyone with the URL can queue bookings with your
2captcha credit. Keep the URL private or put Railway's private networking /
an access layer in front.

## Environment

| var | default | notes |
|-----|---------|-------|
| `TWO_CAPTCHA_API_KEY` | – | required for the Turnstile gate |
| `RELEASE_TIME` | `00:00` | when the 7-days-ahead day drops (London time, TBC) |
| `WARMUP_MINUTES` | `2` | head start before `RELEASE_TIME` |
| `POLL_SECONDS` | `10` | reload cadence while waiting for the drop |
| `MAX_WAIT_MINUTES` | `60` | give up if the day never opens |
| `PROBE_POLL_MINUTES` | `5` | probe-job reload cadence |
| `PROBE_MAX_HOURS` | `24` | probe-job give-up deadline |
| `AUTO_PROBE` | `false` | `true` = keep a nightly release-time probe queued |
| `BOOKING_WINDOW_DAYS` | `7` | site's advance-booking window |
| `PORT` | `8080` | injected by Railway |
| `DATA_DIR` | `./data` | queue + profile + artifacts (Railway volume) |
| `HEADLESS` | `true` | `false` to watch the browser locally |
| `PUPPETEER_EXECUTABLE_PATH` | – | Chrome binary (set in Docker; needed on macOS) |
| `AUTH_EMAIL` | – | the single account allowed to sign in |
| `AUTH_PASSWORD_HASH` | – | salted scrypt hash; never store the plaintext password |
| `SESSION_SECRET` | – | random secret used to sign HTTP-only sessions |

## Repo layout

```
server/src/
  index.ts              Express + static web build + scheduler startup
  config.ts             env + paths (TZ forced to Europe/London)
  api/routes.ts         /api/config, /api/jobs CRUD, run-now, artifacts
  jobs/                 types, JSON-file store, scheduler, fire-time calc
  booking/              browser launch, Turnstile/2captcha, slot parsing+matching, job runner
  cli/                  book.ts, probe-release.ts
web/src/                React app: booking form + job list
Dockerfile              multi-stage build; runtime = node + chromium
railway.json            Railway build/deploy config
```

The original standalone proof-of-concept (`tth-scraper/`, plain JS) lives in
the first commit of this repo.

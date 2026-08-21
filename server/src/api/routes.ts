import express, { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { artifactsDir, config, probeProfileDir } from "../config";
import { parseHour } from "../booking/availability";
import { computeFireAt } from "../jobs/schedule";
import { JobStore } from "../jobs/store";
import { BookingDetails, CourtType, JobKind, StopAt } from "../jobs/types";

const COURT_TYPES: CourtType[] = ["padel", "tennis"];
const STOP_ATS: StopAt[] = ["basket", "details", "payment"];

function badRequest(message: string): Error & { status?: number } {
  const err: Error & { status?: number } = new Error(message);
  err.status = 400;
  return err;
}

function parseDetails(body: Record<string, unknown>): BookingDetails {
  const d = (body.details || {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const fullName = str(d.fullName);
  const email = str(d.email);
  const mobile = str(d.mobile);
  const dob = str(d.dob);
  const gender = str(d.gender);
  if (!fullName || !email || !mobile) {
    throw badRequest("details.fullName, details.email and details.mobile are required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    throw badRequest("details.dob is required and must be YYYY-MM-DD");
  }
  if (!["f", "m", "n"].includes(gender)) {
    throw badRequest("details.gender is required and must be f, m or n");
  }
  const details: BookingDetails = {
    fullName,
    email,
    mobile,
    dob,
    gender: gender as BookingDetails["gender"]
  };
  if (str(d.otherTel)) details.otherTel = str(d.otherTel);
  return details;
}

export function buildRouter(store: JobStore): Router {
  const router = express.Router();

  router.get("/config", (_req, res) => {
    res.json({
      venues: config.venues,
      bookingWindowDays: config.bookingWindowDays,
      releaseTime: config.releaseTime,
      warmupMinutes: config.warmupMinutes,
      timezone: process.env.TZ
    });
  });

  router.get("/jobs", (_req, res) => {
    res.json(store.list());
  });

  router.post("/jobs", async (req, res, next) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;

      const kind = (body.kind as JobKind) || "booking";
      if (!["booking", "probe"].includes(kind)) throw badRequest("kind must be booking or probe");

      const date = typeof body.date === "string" ? body.date : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("date must be YYYY-MM-DD");

      const venue = typeof body.venue === "string" && body.venue ? body.venue : config.venues[0];
      if (!/^[a-z0-9-]+$/.test(venue)) throw badRequest("venue must be a slug like bethnal-green-gardens");

      const fireAt = computeFireAt(date, config);

      // A probe only needs a venue and a date to watch.
      if (kind === "probe") {
        const job = await store.add({
          kind,
          venue,
          date,
          fireAt: fireAt.toISOString(),
          status: "scheduled"
        });
        return res.status(201).json(job);
      }

      const hour = parseHour(String(body.time ?? ""));

      const courtType = String(body.courtType ?? "") as CourtType;
      if (!COURT_TYPES.includes(courtType)) throw badRequest("courtType must be padel or tennis");

      let courtNumber: number | undefined;
      if (body.courtNumber !== undefined && body.courtNumber !== null && body.courtNumber !== "") {
        courtNumber = Number(body.courtNumber);
        if (!Number.isInteger(courtNumber) || courtNumber < 1) {
          throw badRequest("courtNumber must be a positive integer");
        }
      }

      // "checkout" was the old, ambiguous name for the page immediately after
      // details. Keep accepting it for existing clients, but the runner now
      // proves it has reached an actual payment page.
      const requestedStop = body.stopAt === "checkout" ? "payment" : body.stopAt;
      const stopAt = (requestedStop as StopAt) || "payment";
      if (!STOP_ATS.includes(stopAt)) throw badRequest("stopAt must be basket, details or payment");

      const details = parseDetails(body);

      const job = await store.add({
        kind,
        venue,
        date,
        hour,
        courtType,
        courtNumber,
        details,
        stopAt,
        fireAt: fireAt.toISOString(),
        status: "scheduled"
      });
      res.status(201).json(job);
    } catch (err) {
      next(err);
    }
  });

  // Re-arm a job to fire on the next scheduler tick (also retries failures).
  router.post("/jobs/:id/run", async (req, res, next) => {
    try {
      const job = store.get(req.params.id);
      if (!job) return res.status(404).json({ error: "no such job" });
      if (job.status === "running") throw badRequest("job is already running");
      const updated = await store.update(job.id, {
        status: "scheduled",
        fireAt: new Date().toISOString(),
        error: undefined
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/jobs/:id", async (req, res, next) => {
    try {
      const job = store.get(req.params.id);
      if (!job) return res.status(404).json({ error: "no such job" });
      if (job.status === "running") throw badRequest("job is running; wait for it to finish");
      await store.remove(job.id);
      await fs.rm(artifactsDir(job.id), { recursive: true, force: true });
      await fs.rm(probeProfileDir(job.id), { recursive: true, force: true });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/jobs/:id/artifacts", async (req, res) => {
    if (!store.get(req.params.id)) return res.status(404).json({ error: "no such job" });
    const files = await fs.readdir(artifactsDir(req.params.id)).catch(() => [] as string[]);
    res.json(files.sort());
  });

  router.get("/jobs/:id/artifacts/:file", async (req, res) => {
    if (!store.get(req.params.id)) return res.status(404).json({ error: "no such job" });
    const file = path.basename(req.params.file);
    if (!/\.(png|html|json)$/.test(file)) return res.status(400).json({ error: "bad file name" });
    res.sendFile(path.join(artifactsDir(req.params.id), file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "no such artifact" });
    });
  });

  return router;
}

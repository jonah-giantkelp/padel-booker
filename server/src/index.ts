import { config, jobsFile } from "./config";

import path from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { buildRouter } from "./api/routes";
import { startPreviewRefresher } from "./booking/preview";
import { startScheduler } from "./jobs/scheduler";
import { JobStore } from "./jobs/store";
import { log } from "./log";
import { assertAuthConfigured, authRouter, requireAuth } from "./auth";

async function main(): Promise<void> {
  assertAuthConfigured();
  const store = new JobStore(jobsFile());
  await store.init();

  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/auth", authRouter());
  app.use("/api", requireAuth, buildRouter(store));

  // Built React app (web/dist), with an SPA fallback for non-API routes.
  const webDist = path.join(__dirname, "..", "..", "web", "dist");
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"), (err) => {
      if (err) res.status(404).send("Web build not found — run: npm run build --workspace web");
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || 500).json({ error: err.message });
  });

  const server = app.listen(config.port, () => {
    log(`🚀 padel-booker listening on :${config.port} (TZ=${process.env.TZ}, release=${config.releaseTime} TBC)`);
  });

  const stop = startScheduler(store);
  const stopRefresher = startPreviewRefresher();
  const shutdown = (signal: string) => {
    log(`🛑 ${signal} — shutting down`);
    stop();
    stopRefresher();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

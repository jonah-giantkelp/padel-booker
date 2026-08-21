import crypto from "node:crypto";
import { NextFunction, Request, Response, Router } from "express";
import { config } from "./config";

const COOKIE = "padel_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const attempts = new Map<string, { count: number; resetAt: number }>();

function readCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function sign(value: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

function createSession(): string {
  const payload = Buffer.from(JSON.stringify({ email: config.authEmail, exp: Date.now() + SESSION_SECONDS * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function authenticated(req: Request): boolean {
  const token = readCookie(req);
  if (!token || !config.sessionSecret) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const supplied = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.email === config.authEmail && Number(data.exp) > Date.now();
  } catch { return false; }
}

function passwordMatches(password: string): boolean {
  const [saltHex, hashHex] = config.authPasswordHash.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

const cookieFlags = () => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${config.nodeEnv === "production" ? "; Secure" : ""}`;

export function assertAuthConfigured(): void {
  if (!config.authEmail || !config.authPasswordHash || !config.sessionSecret) {
    throw new Error("AUTH_EMAIL, AUTH_PASSWORD_HASH and SESSION_SECRET must be configured");
  }
}

export function authRouter(): Router {
  const router = Router();
  router.get("/status", (req, res) => res.json({ authenticated: authenticated(req) }));
  router.post("/login", (req, res) => {
    const key = req.ip || "unknown";
    const now = Date.now();
    const attempt = attempts.get(key);
    if (attempt && attempt.resetAt > now && attempt.count >= 5) return res.status(429).json({ error: "Too many attempts. Try again later." });
    if (attempt && attempt.resetAt <= now) attempts.delete(key);
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (email !== config.authEmail.toLowerCase() || !passwordMatches(password)) {
      const next = attempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
      next.count += 1;
      attempts.set(key, next);
      return res.status(401).json({ error: "Invalid email or password" });
    }
    attempts.delete(key);
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(createSession())}; ${cookieFlags()}`);
    return res.json({ authenticated: true });
  });
  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.nodeEnv === "production" ? "; Secure" : ""}`);
    res.status(204).end();
  });
  return router;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (authenticated(req)) return next();
  res.status(401).json({ error: "Authentication required" });
}

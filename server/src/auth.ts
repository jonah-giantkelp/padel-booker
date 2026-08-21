import crypto from "node:crypto";
import { NextFunction, Request, Response, Router } from "express";
import { config } from "./config";

const COOKIE = "padel_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const attempts = new Map<string, { count: number; resetAt: number }>();

/** All accounts: the single AUTH_EMAIL pair plus any AUTH_USERS entries. */
function users(): Array<{ email: string; hash: string }> {
  const list: Array<{ email: string; hash: string }> = [];
  if (config.authEmail && config.authPasswordHash) {
    list.push({ email: config.authEmail.toLowerCase(), hash: config.authPasswordHash });
  }
  for (const line of config.authUsers.split(/[\n,]/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.indexOf(":");
    const email = trimmed.slice(0, first).trim().toLowerCase();
    const hash = trimmed.slice(first + 1).trim();
    if (email && hash) list.push({ email, hash });
  }
  return list;
}

function isKnownEmail(email: string): boolean {
  return users().some((u) => u.email === email);
}

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

function createSession(email: string): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: Date.now() + SESSION_SECONDS * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** The validated session email, or null if the request isn't authenticated. */
export function sessionEmail(req: Request): string | null {
  const token = readCookie(req);
  if (!token || !config.sessionSecret) return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const supplied = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = String(data.email).toLowerCase();
    return isKnownEmail(email) && Number(data.exp) > Date.now() ? email : null;
  } catch { return null; }
}

function authenticated(req: Request): boolean {
  try {
    return sessionEmail(req) !== null;
  } catch { return false; }
}

function passwordMatches(email: string, password: string): boolean {
  const user = users().find((u) => u.email === email);
  if (!user) return false;
  const [saltHex, hashHex] = user.hash.split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

const cookieFlags = () => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${config.nodeEnv === "production" ? "; Secure" : ""}`;

export function assertAuthConfigured(): void {
  if (!config.sessionSecret || users().length === 0) {
    throw new Error(
      "SESSION_SECRET plus at least one account (AUTH_EMAIL/AUTH_PASSWORD_HASH or AUTH_USERS) must be configured"
    );
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
    if (!passwordMatches(email, password)) {
      const next = attempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
      next.count += 1;
      attempts.set(key, next);
      return res.status(401).json({ error: "Invalid email or password" });
    }
    attempts.delete(key);
    res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(createSession(email))}; ${cookieFlags()}`);
    return res.json({ authenticated: true });
  });
  router.post("/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.nodeEnv === "production" ? "; Secure" : ""}`);
    res.status(204).end();
  });
  return router;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const email = sessionEmail(req);
  if (email) {
    res.locals.email = email;
    return next();
  }
  res.status(401).json({ error: "Authentication required" });
}

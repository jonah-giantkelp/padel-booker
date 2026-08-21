import axios from "axios";
import type { Page } from "puppeteer";
import { config } from "../config";
import { delay, log } from "../log";
import { NAV_TIMEOUT_MS } from "./browser";

const TWO_CAPTCHA_BASE = "https://api.2captcha.com";

interface SolveParams {
  websiteUrl: string;
  websiteKey: string;
  action?: string;
  userAgent?: string;
}

async function solveTurnstile({ websiteUrl, websiteKey, action, userAgent }: SolveParams): Promise<string> {
  const task: Record<string, string> = {
    type: "TurnstileTaskProxyless",
    websiteURL: websiteUrl,
    websiteKey
  };
  if (action) task.action = action;
  if (userAgent) task.userAgent = userAgent;

  log("2captcha: creating Turnstile task", { websiteUrl, websiteKey });
  const create = await axios.post(
    `${TWO_CAPTCHA_BASE}/createTask`,
    { clientKey: config.twoCaptchaApiKey, task, softId: 0 },
    { timeout: 30000 }
  );
  if (create.data?.errorId) {
    throw new Error(`2captcha createTask failed: ${create.data.errorCode || create.data.errorDescription}`);
  }
  const taskId = create.data?.taskId;
  if (!taskId) throw new Error("2captcha createTask returned no taskId");
  log("2captcha: task created, polling", { taskId });

  await delay(10000);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const res = await axios.post(
      `${TWO_CAPTCHA_BASE}/getTaskResult`,
      { clientKey: config.twoCaptchaApiKey, taskId },
      { timeout: 30000 }
    );
    if (res.data?.errorId) {
      throw new Error(`2captcha getTaskResult failed: ${res.data.errorCode || res.data.errorDescription}`);
    }
    if (res.data?.status === "ready") {
      const token = res.data.solution?.token;
      if (!token) throw new Error("2captcha ready but no token");
      log("2captcha: token received", { length: token.length });
      return token;
    }
    await delay(5000);
  }
  throw new Error("2captcha Turnstile solve timed out");
}

export function onVerifyPage(page: Page): boolean {
  return page.url().includes("/verify-human");
}

async function readSitekey(page: Page): Promise<{ sitekey: string | null; action: string | null } | null> {
  return page.evaluate(() => {
    const el = document.querySelector(".cf-turnstile[data-sitekey], [data-sitekey]");
    if (el) {
      return { sitekey: el.getAttribute("data-sitekey"), action: el.getAttribute("data-action") };
    }
    const iframe = document.querySelector("iframe[src*='challenges.cloudflare.com']");
    if (iframe) {
      const m = (iframe.getAttribute("src") || "").match(/\/(0x[A-Za-z0-9_-]+)\//);
      if (m) return { sitekey: m[1], action: null };
    }
    return null;
  });
}

async function injectAndSubmit(page: Page, token: string): Promise<void> {
  await page.evaluate((t) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    // Turnstile posts its token in a hidden input named cf-turnstile-response.
    let input = document.querySelector<HTMLInputElement>("input[name='cf-turnstile-response']");
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = "cf-turnstile-response";
      (document.getElementById("verify-form") || document.forms[0])?.appendChild(input);
    }
    // Keep this callback free of nested functions: tsx/esbuild can otherwise
    // inject its private __name helper, which does not exist in the browser.
    if (setter) setter.call(input, t);
    else input.value = t;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const widgetInput = document.querySelector<HTMLInputElement>(
      "[id^='cf-chl-widget-'][id$='_response']"
    );
    if (widgetInput && widgetInput !== input) {
      if (setter) setter.call(widgetInput, t);
      else widgetInput.value = t;
      widgetInput.dispatchEvent(new Event("input", { bubbles: true }));
      widgetInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const btn = document.getElementById("submit-btn") as HTMLButtonElement | null;
    if (btn) btn.disabled = false;
    const form = (document.getElementById("verify-form") as HTMLFormElement | null) || document.forms[0];
    if (form) form.submit();
  }, token);
}

async function passGate(page: Page): Promise<void> {
  log("On verify-human gate; attempting to pass");

  // Some Turnstile deployments auto-clear with a clean fingerprint. Give it a
  // short window to redirect on its own before spending a 2captcha solve.
  for (let i = 0; i < 10; i++) {
    await delay(1500);
    if (!onVerifyPage(page)) {
      log("Gate cleared automatically (no solve needed)");
      return;
    }
  }

  if (!config.twoCaptchaApiKey) {
    throw new Error(
      "Still on verify-human and TWO_CAPTCHA_API_KEY is not set. " +
        "Set it to solve the Turnstile, or run with HEADLESS=false to solve manually."
    );
  }

  const widget = await readSitekey(page);
  if (!widget?.sitekey) throw new Error("Could not read Turnstile sitekey from verify-human page");
  log("Read Turnstile widget", widget);

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const token = await solveTurnstile({
    websiteUrl: page.url(),
    websiteKey: widget.sitekey,
    action: widget.action || undefined,
    userAgent
  });

  await injectAndSubmit(page, token);
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS }).catch(() => {});

  if (onVerifyPage(page)) {
    throw new Error("Submitted Turnstile token but still stuck on verify-human");
  }
  log("Gate passed");
}

/** Navigate to url, passing the verify-human gate if it appears. */
export async function gotoThroughGate(page: Page, url: string): Promise<void> {
  log("Navigating", { url });
  await page.goto(url, { waitUntil: "networkidle2" });
  if (onVerifyPage(page)) {
    await passGate(page);
    log("Re-loading target after passing gate");
    await page.goto(url, { waitUntil: "networkidle2" });
  }
  if (onVerifyPage(page)) {
    throw new Error("Could not get past the verify-human gate");
  }
}

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { config } from "../config";

puppeteerExtra.use(StealthPlugin());

export const NAV_TIMEOUT_MS = 120000;
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Stealth Chromium with a persistent profile: the Cloudflare clearance cookie
 * survives between runs, so only the first run (or an expired cookie) costs a
 * 2captcha solve.
 */
export async function launchBrowser(profileDir: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await puppeteerExtra.launch({
    headless: config.headless,
    executablePath: config.puppeteerExecutablePath,
    userDataDir: profileDir,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1400,1000"]
  });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1400, height: 1000 });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  return { browser, page };
}

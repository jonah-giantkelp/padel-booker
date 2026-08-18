import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "puppeteer";
import { artifactsDir, config, profileDir } from "../config";
import { BookingDetails, BookingJob, JobResult } from "../jobs/types";
import { delay, log } from "../log";
import {
  extractSlots,
  findSlot,
  hasAvailabilityTable,
  closedMessage,
  noSlotError,
  Slot
} from "./availability";
import { launchBrowser, NAV_TIMEOUT_MS } from "./browser";
import { gotoThroughGate } from "./turnstile";

async function saveArtifacts(page: Page, dir: string, name: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.html`), await page.content());
  await page.screenshot({ path: path.join(dir, `${name}.png`) as `${string}.png`, fullPage: true });
}

/**
 * Reload the availability page until the day is released (it may be minutes
 * away if we fired at warmup time), then return the parsed slots.
 */
async function waitUntilOpen(page: Page, url: string): Promise<void> {
  const deadline = Date.now() + config.maxWaitMinutes * 60000;
  for (;;) {
    if (await hasAvailabilityTable(page)) return;
    const msg = await closedMessage(page);
    if (Date.now() > deadline) {
      throw new Error(
        `Day still not bookable after ${config.maxWaitMinutes}min of polling — "${msg || "no availability table"}"`
      );
    }
    log(`Not open yet ("${msg || "no table"}"); polling again in ${config.pollSeconds}s`);
    await delay(config.pollSeconds * 1000);
    await gotoThroughGate(page, url);
  }
}

/** Tick the slot's checkbox and submit "Add selected items to basket". */
async function addToBasket(page: Page, token: string): Promise<void> {
  // Click the label so the site's own JS runs (it reveals the basket button).
  const clicked = await page.evaluate((t) => {
    const input = document.querySelector<HTMLInputElement>(`input.bookable[value="${t}"]`);
    if (!input) return false;
    (input.closest("label") || input).click();
    if (!input.checked) input.click();
    return input.checked;
  }, token);
  if (!clicked) throw new Error(`Could not tick checkbox for token ${token}`);

  await delay(500);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS }),
    page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>("button[name='action'][value='book']");
      if (btn) {
        btn.classList.remove("js-hide");
        btn.disabled = false;
        btn.click();
        return;
      }
      // Fallback: submit the form directly with action=book.
      const form = document.querySelector<HTMLFormElement>("form[action='/book/courts']");
      if (!form) throw new Error("Booking form not found");
      const action = document.createElement("input");
      action.type = "hidden";
      action.name = "action";
      action.value = "book";
      form.appendChild(action);
      form.submit();
    })
  ]);
}

/**
 * Fill the basket page's "Your details" form (#frm_basket_customer: name,
 * email, mobile, tel, dob, gender).
 */
async function fillDetails(page: Page, details: BookingDetails): Promise<void> {
  const ok = await page.evaluate((d) => {
    const form = document.getElementById("frm_basket_customer") as HTMLFormElement | null;
    if (!form) return false;
    const set = (name: string, value: string | undefined) => {
      if (!value) return;
      const input = form.querySelector<HTMLInputElement>(`input[name='${name}']`);
      if (!input) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    set("name", d.fullName);
    set("email", d.email);
    set("mobile", d.mobile);
    set("tel", d.otherTel);
    set("dob", d.dob);
    if (d.gender) {
      const radio = form.querySelector<HTMLInputElement>(`input[name='gender'][value='${d.gender}']`);
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return true;
  }, details as unknown as Record<string, string | undefined>);
  if (!ok) throw new Error("Customer details form (#frm_basket_customer) not found on basket page");
}

/** Submit the details form ("Save and checkout") and land on whatever follows. */
async function saveAndCheckout(page: Page): Promise<void> {
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS }),
    page.evaluate(() => {
      const form = document.getElementById("frm_basket_customer") as HTMLFormElement | null;
      if (!form) throw new Error("Customer details form disappeared");
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    })
  ]);
}

/**
 * Execute a booking job end to end: gate -> wait for release -> find slot ->
 * basket -> fill details -> checkout, saving artifacts at each stage and
 * stopping at job.stopAt.
 */
export async function runBookingJob(job: BookingJob): Promise<JobResult> {
  const { hour, courtType, details } = job;
  if (hour === undefined || !courtType || !details) {
    throw new Error("Booking job is missing hour/courtType/details");
  }
  const stopAt = job.stopAt || "checkout";
  const dir = artifactsDir(job.id);
  const url = `${config.baseUrl}/book/courts/${job.venue}/${job.date}`;

  const { browser, page } = await launchBrowser(profileDir());
  try {
    await gotoThroughGate(page, url);
    await waitUntilOpen(page, url);

    const availability = await extractSlots(page);
    log(
      `Availability for ${availability.venue || job.venue} on ${job.date}: ` +
        `${availability.availableCount}/${availability.slotCount} slots available`
    );

    const criteria = { hour, type: courtType, courtNumber: job.courtNumber };
    const { match, candidates } = findSlot(availability.slots, criteria);
    if (!match || !match.token) {
      await saveArtifacts(page, dir, "no-slot");
      throw noSlotError(availability, criteria, candidates);
    }
    log("Found slot", match);

    const asResult = (stage: JobResult["stageReached"], slot: Slot): JobResult => ({
      kind: "booking",
      stageReached: stage,
      finalUrl: page.url(),
      court: slot.court,
      time: slot.time,
      price: slot.price
    });

    await addToBasket(page, match.token);
    await delay(500);
    await saveArtifacts(page, dir, "1-basket");
    log("Slot in basket", { url: page.url() });
    if (stopAt === "basket") return asResult("basket", match);

    await fillDetails(page, details);
    await saveArtifacts(page, dir, "2-details");
    log("Customer details filled");
    if (stopAt === "details") return asResult("details", match);

    await saveAndCheckout(page);
    await delay(500);
    await saveArtifacts(page, dir, "3-checkout");
    log("Details submitted — now on", page.url());
    return asResult("checkout", match);
  } catch (err) {
    await saveArtifacts(page, dir, "error").catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

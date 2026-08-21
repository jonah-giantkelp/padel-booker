import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "puppeteer";
import { artifactsDir, config, profileDir } from "../config";
import { BookingDetails, BookingJob, CardDetails, JobResult } from "../jobs/types";
import { delay, log } from "../log";
import {
  describeCardSurfaces,
  fillAndSubmitCard,
  openCardForm,
  settlePayment
} from "./payment";
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
  const ok = await page.evaluate(
    () => !!document.getElementById("frm_basket_customer")
  );
  if (!ok) throw new Error("Customer details form (#frm_basket_customer) not found on basket page");

  for (const [name, value] of [
    ["name", details.fullName],
    ["email", details.email],
    ["mobile", details.mobile],
    ["tel", details.otherTel],
    ["dob", details.dob]
  ] as const) {
    if (!value) continue;
    await page.evaluate((field) => {
      const input = document.querySelector<HTMLInputElement>(
        `#frm_basket_customer input[name='${field.name}']`
      );
      if (!input) return;
      input.value = field.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, { name, value });
  }
  if (details.gender) {
    await page.evaluate((gender) => {
      const radio = document.querySelector<HTMLInputElement>(
        `#frm_basket_customer input[name='gender'][value='${gender}']`
      );
      if (!radio) return;
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    }, details.gender);
  }
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

type CheckoutPageKind = "payment" | "verification" | "error" | "unknown";

export function classifyCheckoutSnapshot(snapshot: {
  url: string;
  title: string;
  text: string;
  hasCardField: boolean;
  hasPaymentFrame: boolean;
  hasOtpField: boolean;
  hasFormError: boolean;
}): CheckoutPageKind {
  const haystack = `${snapshot.url} ${snapshot.title} ${snapshot.text}`.toLowerCase();
  if (snapshot.hasFormError) return "error";
  if (
    snapshot.hasOtpField ||
    /\b(one[- ]time|verification|security|authentication) (code|password)\b/.test(haystack) ||
    /\benter (the |your )?(code|otp)\b/.test(haystack)
  ) return "verification";
  if (
    snapshot.hasCardField ||
    snapshot.hasPaymentFrame ||
    /\b(card (number|details)|payment details|pay securely|billing address)\b/.test(haystack) ||
    /\/(pay|payment)(\/|\?|$)/.test(snapshot.url.toLowerCase())
  ) return "payment";
  return "unknown";
}

async function checkoutPageKind(page: Page): Promise<CheckoutPageKind> {
  const dom = await page.evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 20000),
    hasCardField: !!document.querySelector(
      "input[autocomplete='cc-number'], input[name*='card' i], input[id*='card' i]"
    ),
    hasPaymentFrame: !!document.querySelector(
      "iframe[src*='stripe' i], iframe[src*='payment' i], iframe[title*='card' i]"
    ),
    hasOtpField: !!document.querySelector(
      "input[autocomplete='one-time-code'], input[name*='otp' i], input[id*='otp' i]"
    ),
    hasFormError: !!document.querySelector(
      ".error:not(:empty), .errors:not(:empty), .validation-summary-errors:not(:empty)"
    )
  }));
  return classifyCheckoutSnapshot({ url: page.url(), ...dom });
}

/**
 * Execute a booking job end to end: gate -> wait for release -> find slot ->
 * basket -> fill details -> verified payment page, saving artifacts at each stage and
 * stopping at job.stopAt.
 */
export async function runBookingJob(job: BookingJob, card?: CardDetails): Promise<JobResult> {
  const { hour, courtType, details } = job;
  if (hour === undefined || !courtType || !details) {
    throw new Error("Booking job is missing hour/courtType/details");
  }
  const stopAt = job.stopAt || "payment";
  if (stopAt !== "basket" && stopAt !== "details" && (!details.dob || !details.gender)) {
    throw new Error("Payment-stage jobs require customer date of birth and gender");
  }
  if (stopAt === "paid" && !card) {
    throw new Error("stopAt=paid requires card details");
  }
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
    const pageKind = await checkoutPageKind(page);
    await saveArtifacts(page, dir, `3-${pageKind}`);
    log("Details submitted", { pageKind, url: page.url() });
    if (pageKind === "verification") {
      throw new Error(
        "Verification/2FA is required before payment. The checkpoint was saved; no code was submitted."
      );
    }
    if (pageKind === "error") {
      throw new Error("The site rejected the customer details; see the saved error-page artifact.");
    }
    if (pageKind !== "payment") {
      throw new Error(
        `Details were submitted but the resulting page was not recognisably a payment page (${page.url()}).`
      );
    }
    // Up to here no card control has been touched.
    if (stopAt === "payment") return asResult("payment", match);

    await openCardForm(page);
    await saveArtifacts(page, dir, "4-card");
    await fs.writeFile(
      path.join(dir, "4-card-surfaces.json"),
      JSON.stringify(await describeCardSurfaces(page), null, 2)
    );
    log("Card form opened", { url: page.url() });
    if (stopAt === "card") return asResult("card", match);

    await fillAndSubmitCard(page, card as CardDetails);
    // Let the processing state replace the form so the screenshot doesn't
    // capture the typed card number.
    await delay(1500);
    await saveArtifacts(page, dir, "5-card-submitted").catch(() => {});
    const outcome = await settlePayment(page, config.paySettleSeconds);
    await saveArtifacts(page, dir, `6-${outcome}`);
    log("Payment settled", { outcome, url: page.url() });
    if (outcome === "paid") return asResult("paid", match);
    if (outcome === "challenge") {
      throw new Error(
        "Payment stopped at a 3DS challenge and it was not approved in time. " +
          "The slot may still be held in the basket — pay manually if you're quick."
      );
    }
    if (outcome === "declined") {
      throw new Error("The card was declined; see the 6-declined artifact for the exact message.");
    }
    throw new Error(
      `Payment was submitted but no confirmation appeared within ${config.paySettleSeconds}s — ` +
        "check the 6-unknown artifact and the venue email before retrying, it MAY have charged."
    );
  } catch (err) {
    await saveArtifacts(page, dir, "error").catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
}

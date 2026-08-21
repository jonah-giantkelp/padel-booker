import type { Frame, Page } from "puppeteer";
import { CardDetails } from "../jobs/types";
import { delay, log } from "../log";
import { NAV_TIMEOUT_MS } from "./browser";

/**
 * The basket page's "Pay with card" form posts to /basket/pay/card. What comes
 * back is a Stripe surface we haven't fully mapped yet — either hosted
 * Checkout (checkout.stripe.com, fields on the top-level page) or Stripe
 * Elements embedded in a site page (fields inside js.stripe.com iframes).
 * Everything here handles both, and the "card" stop stage exists precisely to
 * capture which one it is (see describeCardSurfaces).
 */

const TYPE_DELAY_MS = 30;

/** Click "Pay with card" on the basket page and wait for the card form. */
export async function openCardForm(page: Page): Promise<void> {
  await Promise.all([
    page
      .waitForNavigation({ waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS })
      .catch(() => {}), // an embedded form may appear without navigating
    page.evaluate(() => {
      const form = document.querySelector<HTMLFormElement>("form[action='/basket/pay/card']");
      if (!form) throw new Error("Pay-with-card form (action=/basket/pay/card) not found");
      const btn = form.querySelector<HTMLButtonElement>("button, input[type='submit']");
      if (btn) btn.click();
      else form.submit();
    })
  ]);
  // Wait for something card-shaped: hosted Checkout URL, a Stripe iframe, or a
  // bare cc-number input. Give Stripe's iframes a moment to boot either way.
  await page
    .waitForFunction(
      () =>
        location.hostname.includes("checkout.stripe.com") ||
        !!document.querySelector("iframe[src*='stripe' i]") ||
        !!document.querySelector("input[autocomplete='cc-number'], input[name*='card' i]"),
      { timeout: 20000 }
    )
    .catch(() => {});
  await delay(2000);
}

export interface CardSurface {
  frameUrl: string;
  inputs: Array<{
    name: string;
    id: string;
    type: string;
    autocomplete: string;
    placeholder: string;
    ariaLabel: string;
  }>;
  buttons: string[];
}

/**
 * Inventory every frame's inputs/buttons so a "card" probe run tells us
 * exactly what the payment surface looks like. Saved as a JSON artifact.
 */
export async function describeCardSurfaces(page: Page): Promise<CardSurface[]> {
  const surfaces: CardSurface[] = [];
  for (const frame of page.frames()) {
    try {
      const described = await frame.evaluate(() => ({
        inputs: Array.from(document.querySelectorAll("input, select")).map((el) => ({
          name: el.getAttribute("name") || "",
          id: el.id || "",
          type: el.getAttribute("type") || el.tagName.toLowerCase(),
          autocomplete: el.getAttribute("autocomplete") || "",
          placeholder: el.getAttribute("placeholder") || "",
          ariaLabel: el.getAttribute("aria-label") || ""
        })),
        buttons: Array.from(document.querySelectorAll("button, input[type='submit']"))
          .map((el) => (el.textContent || el.getAttribute("value") || "").trim())
          .filter(Boolean)
      }));
      surfaces.push({ frameUrl: frame.url(), ...described });
    } catch {
      // detached/unreachable frame — skip
    }
  }
  return surfaces;
}

/** Type into the first frame that has a matching field. Returns whether typed. */
async function typeInto(frames: Frame[], selectors: string[], value: string): Promise<boolean> {
  for (const frame of frames) {
    for (const selector of selectors) {
      const handle = await frame.$(selector).catch(() => null);
      if (!handle) continue;
      await handle.click().catch(() => {});
      await frame.type(selector, value, { delay: TYPE_DELAY_MS });
      return true;
    }
  }
  return false;
}

const expiryString = (card: CardDetails) =>
  `${String(card.expMonth).padStart(2, "0")}${String(card.expYear).slice(-2)}`;

/**
 * Fill the card form and click pay. Throws (with a hint at the artifacts) if
 * no known form shape is found. Does NOT wait for the outcome — settlePayment
 * does that.
 */
export async function fillAndSubmitCard(page: Page, card: CardDetails): Promise<void> {
  if (page.url().includes("checkout.stripe.com")) {
    // Hosted Stripe Checkout: fields live on the top-level page.
    for (const [selector, value] of [
      ["#email", ""], // usually prefilled by the merchant; leave alone
      ["#cardNumber", card.number],
      ["#cardExpiry", expiryString(card)],
      ["#cardCvc", card.cvc],
      ["#billingName", card.name],
      ["#billingPostalCode", card.postcode]
    ] as const) {
      if (!value) continue;
      const el = await page.$(selector);
      if (el) await page.type(selector, value, { delay: TYPE_DELAY_MS });
    }
    const submit = (await page.$(".SubmitButton")) || (await page.$("button[type='submit']"));
    if (!submit) throw new Error("Hosted Stripe Checkout: no submit button found");
    await submit.click();
    log("Submitted hosted Stripe Checkout form");
    return;
  }

  // Embedded Stripe Elements: card fields sit inside js.stripe.com iframes.
  const stripeFrames = page.frames().filter((f) => f.url().includes("js.stripe.com"));
  if (stripeFrames.length === 0) {
    throw new Error(
      "Card form not recognised (no hosted Checkout, no Stripe iframes). " +
        "Run a stopAt=card job and inspect the card-surfaces artifact."
    );
  }
  const typedNumber = await typeInto(
    stripeFrames,
    ["input[name='number']", "input[name='cardnumber']", "input[autocomplete='cc-number']"],
    card.number
  );
  if (!typedNumber) {
    throw new Error(
      "Stripe iframes present but no card-number field found; see card-surfaces artifact."
    );
  }
  await typeInto(
    stripeFrames,
    ["input[name='expiry']", "input[name='exp-date']", "input[autocomplete='cc-exp']"],
    expiryString(card)
  );
  await typeInto(
    stripeFrames,
    ["input[name='cvc']", "input[autocomplete='cc-csc']"],
    card.cvc
  );
  await typeInto(
    stripeFrames,
    ["input[name='postalCode']", "input[name='postal']", "input[autocomplete='postal-code']"],
    card.postcode
  );
  // Name usually lives on the merchant page, not in the Stripe frame.
  await typeInto(
    [page.mainFrame()],
    ["input[autocomplete='cc-name']", "input[name*='cardholder' i], input[name*='name_on_card' i]"],
    card.name
  ).catch(() => {});

  // The pay control is the merchant page's own submit button.
  const clicked = await page.evaluate(() => {
    const withStripe = Array.from(document.querySelectorAll("form")).find((form) =>
      form.querySelector("iframe[src*='stripe' i]")
    );
    const candidates = [
      withStripe?.querySelector<HTMLButtonElement>("button[type='submit'], input[type='submit']"),
      ...Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) =>
        /\bpay\b/i.test(b.textContent || "")
      )
    ].filter((el): el is HTMLButtonElement => !!el);
    if (candidates.length === 0) return false;
    candidates[0].click();
    return true;
  });
  if (!clicked) throw new Error("Filled Stripe fields but found no pay/submit button to click");
  log("Submitted embedded Stripe card form");
}

export type PaymentOutcome = "paid" | "challenge" | "declined" | "pending" | "unknown";

export interface PaymentSnapshot {
  url: string;
  title: string;
  text: string;
  hasChallengeFrame: boolean;
  errorText: string;
}

/** Pure classifier so the heuristics are unit-testable. */
export function classifyPaymentSnapshot(snapshot: PaymentSnapshot): PaymentOutcome {
  const haystack = `${snapshot.url} ${snapshot.title} ${snapshot.text}`.toLowerCase();
  if (
    /\b(declined|insufficient funds|card (was|has been) declined|unable to (process|take) (the |your )?payment|payment failed|has not been charged|try a different card)\b/.test(
      `${snapshot.errorText} ${snapshot.text}`.toLowerCase()
    )
  ) {
    return "declined";
  }
  if (
    /\b(booking (is |has been )?confirmed|payment (was )?successful|thank you for your (booking|order|payment)|booking reference)\b/.test(
      haystack
    ) ||
    /\/(confirm(ation)?|complete|success|receipt|thank-?you)(\/|\?|$)/.test(
      snapshot.url.toLowerCase()
    )
  ) {
    return "paid";
  }
  if (
    snapshot.hasChallengeFrame ||
    /\b(verify (your|this) (identity|payment)|approve (this|the) (payment|purchase)|authentication (is )?required|we('|’)ve sent (you )?a (code|text))\b/.test(
      haystack
    )
  ) {
    return "challenge";
  }
  return "pending";
}

async function takeSnapshot(page: Page): Promise<PaymentSnapshot> {
  const challengeFrame = page
    .frames()
    .some((f) => /3d.?secure|three.?d|\/acs\b|challenge|authenticate/i.test(f.url()));
  const dom = await page
    .evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 20000),
      errorText: Array.from(
        document.querySelectorAll(
          ".error, .errors, [role='alert'], .payment-error, .message--error"
        )
      )
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean)
        .join(" | ")
    }))
    .catch(() => ({ title: "", text: "", errorText: "" })); // mid-navigation
  return { url: page.url(), hasChallengeFrame: challengeFrame, ...dom };
}

/**
 * Poll after submitting until the payment resolves. A frictionless 3DS check
 * looks like a challenge frame for a few seconds and then completes on its
 * own, so a sighted challenge keeps polling until the deadline — if the
 * outcome flips to paid meanwhile (e.g. someone approved in a banking app),
 * that wins.
 */
export async function settlePayment(
  page: Page,
  waitSeconds: number
): Promise<Exclude<PaymentOutcome, "pending">> {
  const deadline = Date.now() + waitSeconds * 1000;
  let sawChallenge = false;
  for (;;) {
    const outcome = classifyPaymentSnapshot(await takeSnapshot(page));
    if (outcome === "paid" || outcome === "declined") return outcome;
    if (outcome === "challenge" && !sawChallenge) {
      sawChallenge = true;
      log("3DS challenge detected; waiting for it to resolve");
    }
    if (Date.now() > deadline) return sawChallenge ? "challenge" : "unknown";
    await delay(2000);
  }
}

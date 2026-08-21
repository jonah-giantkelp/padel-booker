import assert from "node:assert/strict";
import test from "node:test";
import { classifyCheckoutSnapshot } from "./run";

const base = {
  url: "https://example.test/checkout",
  title: "Checkout",
  text: "",
  hasCardField: false,
  hasPaymentFrame: false,
  hasOtpField: false,
  hasFormError: false
};

test("recognises a hosted card-entry frame as payment", () => {
  assert.equal(classifyCheckoutSnapshot({ ...base, hasPaymentFrame: true }), "payment");
});

test("verification wins over payment wording", () => {
  assert.equal(
    classifyCheckoutSnapshot({
      ...base,
      text: "Enter your verification code before continuing to payment details",
      hasOtpField: true
    }),
    "verification"
  );
});

test("does not claim an unrecognised checkout page is payment", () => {
  assert.equal(classifyCheckoutSnapshot(base), "unknown");
});

test("surfaces form errors before looking for payment controls", () => {
  assert.equal(
    classifyCheckoutSnapshot({ ...base, hasCardField: true, hasFormError: true }),
    "error"
  );
});

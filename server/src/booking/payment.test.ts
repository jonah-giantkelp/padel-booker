import assert from "node:assert/strict";
import test from "node:test";
import { classifyPaymentSnapshot } from "./payment";

const base = {
  url: "https://tennistowerhamlets.com/basket/pay/card",
  title: "Payment",
  text: "",
  hasChallengeFrame: false,
  errorText: ""
};

test("confirmation wording means paid", () => {
  assert.equal(
    classifyPaymentSnapshot({ ...base, text: "Thank you for your booking. Booking reference TT1234." }),
    "paid"
  );
});

test("a success-looking URL means paid", () => {
  assert.equal(
    classifyPaymentSnapshot({ ...base, url: "https://tennistowerhamlets.com/basket/confirmation" }),
    "paid"
  );
});

test("a 3DS frame means challenge", () => {
  assert.equal(classifyPaymentSnapshot({ ...base, hasChallengeFrame: true }), "challenge");
});

test("challenge wording without a frame still means challenge", () => {
  assert.equal(
    classifyPaymentSnapshot({ ...base, text: "Approve this payment in your banking app" }),
    "challenge"
  );
});

test("a decline message wins over everything", () => {
  assert.equal(
    classifyPaymentSnapshot({
      ...base,
      hasChallengeFrame: true,
      errorText: "Your card was declined"
    }),
    "declined"
  );
});

test("no signal yet means pending", () => {
  assert.equal(classifyPaymentSnapshot(base), "pending");
});

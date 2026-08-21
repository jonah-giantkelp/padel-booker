import assert from "node:assert/strict";
import test from "node:test";
import { cardVaultReady, decryptCard, encryptCard } from "./cardVault";
import { CardDetails } from "./types";

const card: CardDetails = {
  number: "4242424242424242",
  expMonth: 12,
  expYear: 2030,
  cvc: "123",
  name: "J Ramchandani",
  postcode: "E2 0EU"
};

test("vault is not ready without a key", () => {
  delete process.env.CARD_ENC_KEY;
  assert.equal(cardVaultReady(), false);
  assert.throws(() => encryptCard(card), /CARD_ENC_KEY/);
});

test("round-trips a card and never stores plaintext", () => {
  process.env.CARD_ENC_KEY = "ab".repeat(32);
  const blob = encryptCard(card);
  assert.ok(blob.startsWith("v1:"));
  assert.ok(!blob.includes(card.number));
  assert.deepEqual(decryptCard(blob), card);
});

test("a tampered blob fails to decrypt", () => {
  process.env.CARD_ENC_KEY = "ab".repeat(32);
  const blob = encryptCard(card);
  const tampered = blob.slice(0, -4) + (blob.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => decryptCard(tampered));
});

test("a different key cannot decrypt", () => {
  process.env.CARD_ENC_KEY = "ab".repeat(32);
  const blob = encryptCard(card);
  process.env.CARD_ENC_KEY = "cd".repeat(32);
  assert.throws(() => decryptCard(blob));
});

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CardDetails } from "./types";

/**
 * Field-level encryption for card details held in the job store. The key lives
 * only in the CARD_ENC_KEY env var (32 bytes, hex — `openssl rand -hex 32`),
 * so the jobs.json on the data volume is useless without the deploy's env.
 */

// Read at call time (not via config) so tests can set the env per-file.
const keyHex = () => process.env.CARD_ENC_KEY || "";

export const cardVaultReady = (): boolean => /^[0-9a-f]{64}$/i.test(keyHex());

function key(): Buffer {
  if (!cardVaultReady()) {
    throw new Error(
      "CARD_ENC_KEY is not set (or not 64 hex chars). Generate one with `openssl rand -hex 32`."
    );
  }
  return Buffer.from(keyHex(), "hex");
}

export function encryptCard(card: CardDetails): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(card), "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64")
  ].join(":");
}

export function decryptCard(blob: string): CardDetails {
  const [version, ivB64, tagB64, ctB64] = blob.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("Stored card blob is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(plain) as CardDetails;
}

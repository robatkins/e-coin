import test from "node:test";
import assert from "node:assert/strict";
import { createSignedTransferEnvelope, createUnsignedTransferEnvelope, validateSignedTransferEnvelope, validateUnsignedTransferEnvelope } from "../public/offline-transfer.js";

const now = 1_800_000_000_000;
const tx = { from:`ec1${"a".repeat(38)}`, to:`ec1${"b".repeat(38)}`, amount:5_000_000, fee:1_000, nonce:3, memo:"offline", timestamp:now, publicKey:{ kty:"OKP", crv:"Ed25519", x:"abc" } };

test("unsigned envelopes round-trip validated transaction intent", () => {
  const envelope = createUnsignedTransferEnvelope(tx, now);
  const result = validateUnsignedTransferEnvelope(envelope, { now:now + 1_000, expectedFrom:tx.from, expectedNonce:3, availableBalance:6_000_000 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.transaction, tx);
});

test("unsigned envelope validation rejects stale nonce, expiry, and overspending", () => {
  const envelope = createUnsignedTransferEnvelope(tx, now);
  const result = validateUnsignedTransferEnvelope(envelope, { now:now + 31 * 60_000, expectedNonce:4, availableBalance:1_000 });
  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 3);
});

test("signed envelopes preserve intent and require canonical signature encoding", () => {
  const unsigned = createUnsignedTransferEnvelope(tx, now);
  const signature = "A".repeat(86);
  const signed = createSignedTransferEnvelope(unsigned, signature, now + 1_000);
  assert.equal(validateSignedTransferEnvelope(signed, { now:now + 2_000, expectedNonce:3, availableBalance:6_000_000 }).valid, true);
  signed.transaction.signature = "not-valid";
  assert.equal(validateSignedTransferEnvelope(signed, { now:now + 2_000 }).valid, false);
});

test("offline signing rejects a draft whose public key was substituted", () => {
  const envelope = createUnsignedTransferEnvelope(tx, now);
  envelope.transaction.publicKey = { ...tx.publicKey, x:"attacker" };
  const result = validateUnsignedTransferEnvelope(envelope, { now:now + 1_000, expectedFrom:tx.from, expectedPublicKey:tx.publicKey });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /public key/i);
});

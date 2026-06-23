import test from "node:test";
import assert from "node:assert/strict";
import { decryptWalletVault, encryptWalletVault } from "../public/vault.js";

const sampleWallets = [
  {
    version: 1,
    id: "ec1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "Primary",
    publicKey: { x: "public-one" },
    privateKey: { d: "private-one" },
    address: "ec1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-06-22T00:00:00.000Z",
  },
  {
    version: 1,
    id: "ec1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    name: "Savings",
    publicKey: { x: "public-two" },
    privateKey: { d: "private-two" },
    address: "ec1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    createdAt: "2026-06-22T00:00:00.000Z",
  },
];

test("vault encryption round-trips wallet data", async () => {
  const envelope = await encryptWalletVault(sampleWallets, "correct horse battery staple");
  const recovered = await decryptWalletVault(envelope, "correct horse battery staple");
  assert.deepEqual(recovered, sampleWallets);
  assert.deepEqual(envelope.index.map((wallet) => wallet.address), sampleWallets.map((wallet) => wallet.address));
});

test("vault decryption fails with the wrong password", async () => {
  const envelope = await encryptWalletVault(sampleWallets, "correct horse battery staple");
  await assert.rejects(() => decryptWalletVault(envelope, "wrong password"), /decrypt|operation failed|Vault/);
});

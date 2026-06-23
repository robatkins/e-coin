import test from "node:test";
import assert from "node:assert/strict";
import { decryptRecoveryBundle, decryptWalletVault, encryptRecoveryBundle, encryptWalletVault } from "../public/vault.js";

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

test("encrypted recovery bundles round-trip wallet and local intelligence data", async () => {
  const bundle = { version:2, wallet:sampleWallets[0], contacts:[{ name:"Savings", address:sampleWallets[1].address }], transactionGuard:{ dailyLimit:5_000_000, reserve:1_000_000, knownOnly:true } };
  const envelope = await encryptRecoveryBundle(bundle, "independent recovery password");
  assert.equal(envelope.kind, "ecoin-encrypted-recovery");
  assert.equal(JSON.stringify(envelope).includes("private-one"), false);
  assert.deepEqual(await decryptRecoveryBundle(envelope, "independent recovery password"), bundle);
});

test("recovery authentication rejects wrong passwords and modified ciphertext", async () => {
  const envelope = await encryptRecoveryBundle({ version:2, wallet:sampleWallets[0] }, "independent recovery password");
  await assert.rejects(() => decryptRecoveryBundle(envelope, "incorrect password"), /incorrect|modified/i);
  const tampered = { ...envelope, ciphertext:`${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}` };
  await assert.rejects(() => decryptRecoveryBundle(tampered, "independent recovery password"), /incorrect|modified/i);
});

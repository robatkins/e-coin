import test from "node:test";
import assert from "node:assert/strict";
import { planRebalance } from "../public/rebalance.js";

const wallets = (balances) => balances.map((balance, index) => ({ address:`wallet-${index}`, name:`Wallet ${index}`, balance }));

test("equal-weight planning minimizes movement while reserving the transfer fee", () => {
  const result = planRebalance({ wallets:wallets([100, 0]), strategy:"equal", fee:1, minimum:1 });
  assert.equal(result.moves.length, 1);
  assert.deepEqual(result.moves[0], { from:"wallet-0", fromName:"Wallet 0", to:"wallet-1", toName:"Wallet 1", amount:49, fee:1 });
  assert.deepEqual(result.wallets.map((entry) => entry.balance), [50, 49]);
  assert.equal(result.fees, 1);
});

test("reserve-floor planning funds deficits without draining the source below its floor", () => {
  const result = planRebalance({ wallets:wallets([100, 0]), strategy:"floor", floor:25, buffer:5, fee:1, minimum:1 });
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].amount, 25);
  assert.deepEqual(result.wallets.map((entry) => entry.balance), [74, 25]);
  assert.equal(result.belowFloor, 0);
});

test("minimum-move tolerance suppresses dust recommendations", () => {
  const result = planRebalance({ wallets:wallets([51, 49]), strategy:"equal", fee:0, minimum:2 });
  assert.equal(result.moves.length, 0);
});

test("an underfunded floor remains visible when no safe donor exists", () => {
  const result = planRebalance({ wallets:wallets([20, 0]), strategy:"floor", floor:25, buffer:5, fee:1, minimum:1 });
  assert.equal(result.moves.length, 0);
  assert.equal(result.belowFloor, 2);
});

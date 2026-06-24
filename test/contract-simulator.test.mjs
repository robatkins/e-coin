import test from "node:test";
import assert from "node:assert/strict";
import { simulateContractDraft } from "../public/contract-simulator.js";

const now = 1_800_000_000_000;
const creator = `ec1${"a".repeat(38)}`;
const beneficiary = `ec1${"b".repeat(38)}`;
const base = { now, creator, beneficiary, amount:100_000_000, fee:1_000, availableBalance:500_000_000, guardReserve:5_000_000, knownBeneficiary:true };

test("timelock simulation mirrors protocol timing and balance constraints", () => {
  const result = simulateContractDraft({ ...base, type:"timelock", unlockTime:now + 60_000 });
  assert.equal(result.valid, true);
  assert.equal(result.afterBalance, 399_999_000);
  assert.deepEqual(result.events, [{ at:now + 60_000, amount:100_000_000, label:"Automatic timelock release" }]);
});

test("vesting simulation preserves exact value across remainder installments", () => {
  const result = simulateContractDraft({ ...base, type:"vesting", amount:10, installments:3, intervalMs:60_000, unlockTime:now + 60_000 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.events.map((event) => event.amount), [3, 3, 4]);
  assert.equal(result.events.reduce((sum, event) => sum + event.amount, 0), 10);
});

test("milestone simulation adds approval-aware release guidance", () => {
  const result = simulateContractDraft({ ...base, type:"milestone", amount:12, installments:3, intervalMs:60_000, unlockTime:now + 60_000 });
  assert.equal(result.valid, true);
  assert.deepEqual(result.events.map((event) => event.label), ["Milestone 1 of 3", "Milestone 2 of 3", "Milestone 3 of 3"]);
  assert.equal(result.warnings.some((warning) => warning.includes("approvals")), true);
});

test("hashlock simulation blocks missing secrets and invalid refund horizons", () => {
  const result = simulateContractDraft({ ...base, type:"hashlock", hasSecret:false, refundTime:now + 20_000 });
  assert.equal(result.valid, false);
  assert.equal(result.risk >= 90, true);
  assert.equal(result.blocked.length, 2);
});

test("simulation flags unknown beneficiaries and reserve violations", () => {
  const result = simulateContractDraft({ ...base, type:"timelock", amount:498_000_000, unlockTime:now + 60_000, knownBeneficiary:false });
  assert.equal(result.valid, true);
  assert.equal(result.warnings.some((warning) => warning.includes("address book")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("reserve")), true);
});
